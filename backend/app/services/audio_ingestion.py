"""Bounded audio ingestion. Media and transcripts are never logged."""
import asyncio
import concurrent.futures
import threading
import http.client
import ipaddress
import json
import math
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx

from app.core.config import settings
from app.services.attachments import AttachmentError

MAX_BYTES = 25 * 1024 * 1024
MAX_SECONDS = 20 * 60
_DNS_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix='audio-dns')
_DNS_SLOTS = threading.BoundedSemaphore(4)

TYPES = {'.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm'}


def capabilities():
    model = settings.AUDIO_TRANSCRIPTION_MODEL.strip()
    return {'model': model, 'model_warning': 'Whisper-1 is deprecated and supported only until 2027-02-26.' if model == 'whisper-1' else None, 'provider': 'openai', 'provider_label': 'OpenAI', 'available': model in ('gpt-transcribe', 'whisper-1') and bool(settings.AUDIO_TRANSCRIPTION_API_KEY.strip()) and bool(shutil.which('ffprobe')) and bool(shutil.which('ffmpeg')), 'max_bytes': MAX_BYTES, 'max_seconds': MAX_SECONDS, 'extensions': list(TYPES), 'retention': 'Original audio and transcript stay in this conversation until the conversation is deleted. Temporary media is deleted after validation. OpenAI retention policies apply to remote processing.'}


def require_consent(provider: str | None):
    if provider != 'openai':
        raise AttachmentError(422, 'audio_consent_required', 'Consent to send this audio to OpenAI is required before transcription.')
    if settings.AUDIO_TRANSCRIPTION_MODEL.strip() not in ('gpt-transcribe', 'whisper-1'):
        raise AttachmentError(503, 'transcription_model_unsupported', 'Configure AUDIO_TRANSCRIPTION_MODEL as gpt-transcribe or whisper-1. No transcript was created.')
    if not capabilities()['available']:
        raise AttachmentError(503, 'transcription_unavailable', 'Audio transcription requires ffmpeg, ffprobe and a configured AUDIO_TRANSCRIPTION_API_KEY. No transcript was created.')


def _run_media(command, timeout, cancelled):
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    deadline = time.monotonic() + timeout
    try:
        while True:
            if cancelled is not None and cancelled.is_set():
                raise AttachmentError(499, 'audio_cancelled', 'Audio validation was cancelled.')
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(command, timeout)
            try:
                output, errors = process.communicate(timeout=.1)
                if process.returncode:
                    raise subprocess.CalledProcessError(process.returncode, command)
                return subprocess.CompletedProcess(command, process.returncode, output, errors)
            except subprocess.TimeoutExpired:
                continue
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()


def validate(name: str, data: bytes, cancelled=None) -> tuple[str, float]:
    ext = Path(name).suffix.lower()
    if ext not in TYPES:
        raise AttachmentError(415, 'unsupported_audio', 'Supported audio: WAV, MP3, M4A, OGG, FLAC and WebM.')
    if not data:
        raise AttachmentError(400, 'empty_file', 'The audio file is empty.')
    if len(data) > MAX_BYTES:
        raise AttachmentError(413, 'audio_too_large', 'Audio exceeds the 25 MB limit.')
    if not shutil.which('ffprobe'):
        raise AttachmentError(503, 'transcription_unavailable', 'Audio validation requires ffprobe.')
    # A private temporary directory, removed on every exit including validation errors.
    demuxer = {'.wav': 'wav', '.mp3': 'mp3', '.m4a': 'mov', '.ogg': 'ogg', '.flac': 'flac', '.webm': 'matroska'}[ext]
    with tempfile.TemporaryDirectory(prefix='audio-validation-') as folder:
        path = Path(folder) / ('source' + ext)
        path.write_bytes(data)
        try:
            probe = _run_media(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', demuxer, '-show_entries', 'format=duration,format_name:stream=codec_type', '-of', 'json', str(path)], 20, cancelled)
            info = json.loads(probe.stdout)
            duration = float(info['format']['duration'])
            formats = set(info['format']['format_name'].split(','))
            expected = {'.wav': {'wav'}, '.mp3': {'mp3'}, '.m4a': {'mov', 'mp4', 'm4a'}, '.ogg': {'ogg'}, '.flac': {'flac'}, '.webm': {'matroska', 'webm'}}[ext]
            if probe.stderr or not formats & expected or not info.get('streams') or any(s.get('codec_type') != 'audio' for s in info['streams']) or not math.isfinite(duration) or duration <= 0:
                raise ValueError()
            if duration > MAX_SECONDS:
                raise AttachmentError(413, 'audio_too_long', 'Audio exceeds the 20 minute limit. Split the recording before attaching it.')
            _run_media(['ffmpeg', '-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe', '-f', demuxer, '-i', str(path), '-map', '0:a', '-f', 'null', '-'], 30, cancelled)
        except (subprocess.SubprocessError, ValueError, KeyError, OSError):
            raise AttachmentError(415, 'invalid_audio', 'Audio is corrupt, unsupported, or has no reliable duration. No transcript was created.') from None
    return TYPES[ext], duration


async def transcribe(name: str, data: bytes, provider: str | None) -> dict:
    require_consent(provider)
    cancelled = threading.Event()
    try:
        mime, duration = await asyncio.to_thread(validate, name, data, cancelled)
    finally:
        cancelled.set()
    model = capabilities()['model']
    request_data = {'model': model, 'response_format': 'json'}
    # Legacy timestamp support is available only until 2027-02-26.
    if model == 'whisper-1':
        request_data.update({'response_format': 'verbose_json', 'timestamp_granularities[]': 'segment'})
    try:
        async with asyncio.timeout(180), httpx.AsyncClient(timeout=httpx.Timeout(180, connect=15), trust_env=False) as client:
            async with client.stream('POST', 'https://api.openai.com/v1/audio/transcriptions', headers={'Authorization': 'Bearer ' + settings.AUDIO_TRANSCRIPTION_API_KEY.strip()}, files={'file': (name, data, mime)}, data=request_data) as result:
                if result.status_code != 200:
                    raise ValueError()
                response_data = bytearray()
                async for chunk in result.aiter_bytes():
                    response_data.extend(chunk)
                    if len(response_data) > 1024 * 1024:
                        raise ValueError()
                body = json.loads(response_data)
        if 'duration' in body:
            provider_duration = float(body['duration'])
            if not math.isfinite(provider_duration) or abs(provider_duration - duration) > max(2, duration * 0.02):
                raise ValueError()
        text = body['text'].strip()
        if not text or len(text) > 200_000:
            raise ValueError()
        segments = []
        for segment in body.get('segments', []) if model == 'whisper-1' else []:
            start, end = float(segment['start']), float(segment['end'])
            if not math.isfinite(start) or not math.isfinite(end) or not 0 <= start <= end <= duration + 2:
                raise ValueError()
            segment_text = str(segment['text']).strip()
            if float(segment.get('avg_logprob', 0)) < -1 or float(segment.get('no_speech_prob', 0)) > .6:
                segment_text = '[uncertain transcription] ' + segment_text
            segments.append({'id': len(segments) + 1, 'start': start, 'end': end, 'text': segment_text})
        return {'text': text, 'segments': segments, 'duration_seconds': duration, 'provider': 'openai', 'model': model, 'complete': True}
    except (httpx.HTTPError, ValueError, KeyError, TypeError, TimeoutError):
        raise AttachmentError(502, 'transcription_failed', 'The transcription provider failed or returned an invalid transcript. No summary was created. Try again later.') from None


def _destination(url: str):
    try:
        if len(url) > 8192:
            raise ValueError()
        parts = urlsplit(url)
        if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username is not None or parts.password is not None or parts.fragment or parts.port not in (None, 80, 443):
            raise ValueError()
        if not _DNS_SLOTS.acquire(blocking=False):
            raise ValueError()
        lookup = _DNS_POOL.submit(socket.getaddrinfo, parts.hostname, parts.port or (443 if parts.scheme == 'https' else 80), type=socket.SOCK_STREAM)
        lookup.add_done_callback(lambda _: _DNS_SLOTS.release())
        addresses = lookup.result(timeout=5)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise ValueError()
        return parts, addresses[0][4][0]
    except (ValueError, OSError):
        raise AttachmentError(422, 'unsafe_audio_url', 'Use a direct public HTTP(S) audio URL without credentials or fragments.') from None


def fetch_url(url: str, cancelled=None) -> tuple[str, bytes]:
    """Resolve each hop once, validate all addresses, and connect to the pinned IP."""
    deadline = time.monotonic() + 45
    for _ in range(4):
        if time.monotonic() > deadline or cancelled is not None and cancelled.is_set():
            raise AttachmentError(408, 'audio_fetch_cancelled', 'Audio download was cancelled or timed out.')
        parts, address = _destination(url)
        port = parts.port or (443 if parts.scheme == 'https' else 80)
        connection = http.client.HTTPConnection(parts.hostname, port, timeout=10)
        def expire():
            active = connection.sock
            if active is not None:
                try:
                    active.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                active.close()
        timer = threading.Timer(max(.01, deadline - time.monotonic()), expire)
        timer.daemon = True
        timer.start()
        try:
            connection.sock = socket.create_connection((address, port), timeout=10)
            if parts.scheme == 'https':
                connection.sock = ssl.create_default_context().wrap_socket(connection.sock, server_hostname=parts.hostname)
            path = parts.path or '/'
            if parts.query:
                path += '?' + parts.query
            connection.request('GET', path, headers={'Accept': 'audio/*', 'Connection': 'close'})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                if not location:
                    raise ValueError()
                url = urljoin(url, location)
                continue
            if response.status != 200:
                raise ValueError()
            length = response.getheader('Content-Length')
            if length is not None and int(length) > MAX_BYTES:
                raise AttachmentError(413, 'audio_too_large', 'Remote audio exceeds the 25 MB limit.')
            data = bytearray()
            while True:
                if time.monotonic() > deadline or cancelled is not None and cancelled.is_set():
                    raise TimeoutError()
                chunk = response.read1(min(65536, MAX_BYTES + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > MAX_BYTES:
                    raise AttachmentError(413, 'audio_too_large', 'Remote audio exceeds the 25 MB limit.')
            name = Path(parts.path).name
            if Path(name).suffix.lower() not in TYPES:
                mime = response.getheader('Content-Type', '').split(';')[0].strip()
                ext = next((e for e, m in TYPES.items() if m == mime), None)
                if ext is None:
                    raise ValueError()
                name = 'podcast' + ext
            return name, bytes(data)
        except (OSError, ValueError, http.client.HTTPException):
            raise AttachmentError(422, 'audio_url_unavailable', 'Could not fetch direct audio. The URL may require sign-in, be paywalled, blocked, or point to a page instead of audio.') from None
        finally:
            timer.cancel()
            connection.close()
    raise AttachmentError(422, 'audio_redirect_limit', 'The audio URL redirected too many times.')
