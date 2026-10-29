import { createChannels } from './create-channels';

describe('createChannels', () => {
  it('builds nothing for an empty config', () => {
    expect(createChannels({ consoleUrl: 'https://console.example.com' })).toEqual([]);
  });

  it('builds webhook, slack and email in that order', () => {
    const channels = createChannels({
      consoleUrl: 'https://console.example.com',
      email: { smtpUrl: 'smtp://user:pass@localhost:2525', from: 'a@example.com', to: ['b@example.com'] },
      slack: { url: 'https://hooks.slack.com/services/T/B/X' },
      webhook: { url: 'https://hooks.example.com/x', secret: 's' },
    });
    expect(channels.map((c) => c.name)).toEqual(['webhook', 'slack', 'email']);
    channels.forEach((c) => c.close?.());
  });
});
