import { render, screen } from '@testing-library/react-native';

import { WelcomeCard } from '@/components/welcome-card';

let mockScopes: string[] | undefined = ['chat'];

jest.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    state: { status: 'paired', server: 'https://dots.example.com', token: 't', label: 'L', scopes: mockScopes },
    welcome: true,
    dismissWelcome: jest.fn(),
  }),
}));

describe('WelcomeCard', () => {
  it('says agents are managed on the server for a phone paired for chat', async () => {
    mockScopes = ['chat'];
    await render(<WelcomeCard />);
    expect(screen.getByText(/Agents, settings and who can sign in are managed on your server/)).toBeTruthy();
  });

  it('says agents can be created and edited here for a phone paired to manage them', async () => {
    mockScopes = ['chat', 'files', 'manage'];
    await render(<WelcomeCard />);
    expect(screen.getByText(/create and edit agents \(Settings → Agents\)/)).toBeTruthy();
    expect(screen.queryByText(/Agents, settings and who can sign in/)).toBeNull();
  });

  it('treats a saved session with no scopes as chat only', async () => {
    mockScopes = undefined;
    await render(<WelcomeCard />);
    expect(screen.getByText(/managed on your server/)).toBeTruthy();
  });
});
