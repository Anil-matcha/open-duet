"""The Telegram bot spends the operator's Boat quota and runs tasks as them,
so it must serve only the user ids named in TELEGRAM_ALLOWED_USER_IDS."""

from types import SimpleNamespace

import pytest

from app import telegram_bot
from app.core.config import Settings


class _Recorder:
    def __init__(self):
        self.sent = []

    async def reply_text(self, text, **kwargs):
        self.sent.append(text)


def _update(user_id: int | None):
    user = None if user_id is None else SimpleNamespace(id=user_id)
    recorder = _Recorder()
    message = SimpleNamespace(reply_text=recorder.reply_text, sent=recorder.sent)
    return (
        SimpleNamespace(effective_user=user, message=message, callback_query=None),
        message,
    )


@pytest.mark.parametrize(
    "configured, expected",
    [
        ("", frozenset()),
        ("  ", frozenset()),
        ("111", frozenset({111})),
        ("111, 222", frozenset({111, 222})),
        ("111,,222,", frozenset({111, 222})),
        ("not-a-number,333", frozenset({333})),
    ],
)
def test_the_allowlist_is_parsed_and_empty_means_nobody(configured, expected):
    settings = Settings(
        TOKEN_ENCRYPTION_KEYS="x", TELEGRAM_ALLOWED_USER_IDS=configured
    )
    assert settings.TELEGRAM_ALLOWED_USER_ID_SET == expected


async def test_a_stranger_is_refused_before_the_handler_runs(monkeypatch):
    ran = []

    async def handler(update, context):
        ran.append(update)

    monkeypatch.setattr(telegram_bot.settings, "TELEGRAM_ALLOWED_USER_IDS", "111")
    update, message = _update(999)

    await telegram_bot.only_allowed(handler)(update, None)

    assert ran == []
    assert message.sent == [telegram_bot.REFUSAL]


async def test_an_allowed_user_reaches_the_handler(monkeypatch):
    ran = []

    async def handler(update, context):
        ran.append(update)

    monkeypatch.setattr(telegram_bot.settings, "TELEGRAM_ALLOWED_USER_IDS", "111")
    update, message = _update(111)

    await telegram_bot.only_allowed(handler)(update, None)

    assert ran == [update]
    assert message.sent == []


async def test_an_unset_allowlist_refuses_everyone(monkeypatch):
    ran = []

    async def handler(update, context):
        ran.append(update)

    monkeypatch.setattr(telegram_bot.settings, "TELEGRAM_ALLOWED_USER_IDS", "")
    update, message = _update(111)

    await telegram_bot.only_allowed(handler)(update, None)

    assert ran == []
    assert message.sent == [telegram_bot.REFUSAL]


async def test_an_update_with_no_user_is_refused(monkeypatch):
    ran = []

    async def handler(update, context):
        ran.append(update)

    monkeypatch.setattr(telegram_bot.settings, "TELEGRAM_ALLOWED_USER_IDS", "111")
    update, message = _update(None)

    await telegram_bot.only_allowed(handler)(update, None)

    assert ran == []
    assert message.sent == [telegram_bot.REFUSAL]
