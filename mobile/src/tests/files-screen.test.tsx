import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import Files from '../app/files/[id]/index';
import FileView from '../app/files/[id]/view';
import { ApiError } from '@/lib/api';

const mockPush = jest.fn();
const mockParams: { id: string; path?: string } = { id: '4' };
const mockApi = {
  listFiles: jest.fn(),
  previewFile: jest.fn(),
  fileSource: jest.fn((id: number, path: string, kind: string) => ({ uri: `https://s/api/v1/threads/${id}/files/${kind}?path=${path}`, headers: { Authorization: 'Bearer t' } })),
};
const mockShare = jest.fn();

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/lib/use-api', () => ({ useApi: () => mockApi }));
jest.mock('@/lib/file-actions', () => ({ shareFile: (...args: unknown[]) => mockShare(...args) }));

const listing = { path: '', truncated: false, entries: [
  { name: 'reports', path: 'reports', type: 'dir', bytes: null },
  { name: 'plan.md', path: 'plan.md', type: 'file', bytes: 2048 },
  { name: '.env', path: '.env', type: 'hidden', bytes: 10 },
] };

beforeEach(() => {
  jest.clearAllMocks();
  mockParams.path = undefined;
});

describe('Files', () => {
  it('lists the folder and opens a folder or a file', async () => {
    mockApi.listFiles.mockResolvedValue(listing);
    await render(<Files />);
    expect(await screen.findByText('plan.md')).toBeTruthy();
    expect(screen.getByText('2 KB')).toBeTruthy();
    expect(mockApi.listFiles).toHaveBeenCalledWith(4, '');

    await fireEvent.press(screen.getByLabelText('Folder, reports'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/files/[id]', params: { id: '4', path: 'reports' } });
    await fireEvent.press(screen.getByLabelText('File, plan.md, 2 KB'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/files/[id]/view', params: { id: '4', path: 'plan.md' } });
  });

  it('shows a secret file as locked and does not open it', async () => {
    mockApi.listFiles.mockResolvedValue(listing);
    await render(<Files />);
    await screen.findByText('.env');
    expect(screen.getByText('Secret file, not shown')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('File, .env, Secret file, not shown'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('says a phone paired without file access needs a new code, and retries', async () => {
    mockApi.listFiles.mockRejectedValueOnce(new ApiError(403, 'scope_denied', 'This device needs the files scope for that.'));
    mockApi.listFiles.mockResolvedValueOnce({ path: '', truncated: false, entries: [] });
    await render(<Files />);
    expect(await screen.findByText(/Chat and files/)).toBeTruthy();
    await fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByText('This folder is empty.')).toBeTruthy();
  });
});

describe('FileView', () => {
  it('shows a text file and shares it', async () => {
    mockParams.path = 'plan.md';
    mockApi.previewFile.mockResolvedValue({ path: 'plan.md', name: 'plan.md', bytes: 9, mime: 'text/markdown', kind: 'text', text: '# The plan', truncated: false });
    mockShare.mockResolvedValue('shared');
    await render(<FileView />);
    expect(await screen.findByText('# The plan')).toBeTruthy();

    await fireEvent.press(screen.getByText('Share or save'));
    await waitFor(() => expect(mockShare).toHaveBeenCalled());
    expect(mockShare.mock.calls[0][0].uri).toContain('/files/download?path=plan.md');
    expect(mockShare.mock.calls[0].slice(1)).toEqual(['plan.md', 'text/markdown']);
  });

  it('says when the start of a long file is shown', async () => {
    mockParams.path = 'big.log';
    mockApi.previewFile.mockResolvedValue({ path: 'big.log', name: 'big.log', bytes: 900000, mime: 'text/plain', kind: 'text', text: 'line', truncated: true });
    await render(<FileView />);
    expect(await screen.findByText(/Showing the start of the file/)).toBeTruthy();
  });

  it('draws an image from the server with the token', async () => {
    mockParams.path = 'chart.png';
    mockApi.previewFile.mockResolvedValue({ path: 'chart.png', name: 'chart.png', bytes: 100, mime: 'image/png', kind: 'image', text: null, truncated: false });
    await render(<FileView />);
    const image = await screen.findByLabelText('chart.png');
    expect(image.props.source).toEqual({ uri: 'https://s/api/v1/threads/4/files/raw?path=chart.png', headers: { Authorization: 'Bearer t' } });
  });

  it('offers only sharing for a file it cannot preview, and reports a failed download', async () => {
    mockParams.path = 'data.xlsx';
    mockApi.previewFile.mockResolvedValue({ path: 'data.xlsx', name: 'data.xlsx', bytes: 5000, mime: 'application/octet-stream', kind: 'binary', text: null, truncated: false });
    mockShare.mockRejectedValue(new Error('network'));
    await render(<FileView />);
    expect(await screen.findByText(/cannot be previewed here/)).toBeTruthy();
    await fireEvent.press(screen.getByText('Share or save'));
    expect(await screen.findByText(/Could not download the file/)).toBeTruthy();
  });
});
