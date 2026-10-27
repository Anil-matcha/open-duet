import { render, screen } from '@testing-library/react-native';

import Home from '../app/index';

describe('Home', () => {
  it('says the app is not paired yet', async () => {
    await render(<Home />);
    expect(screen.getByText('Not paired yet')).toBeTruthy();
  });
});
