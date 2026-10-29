import { emailChannel } from './email.channel';
import type { NotifyConfig } from './notify-config';
import { slackChannel } from './slack.channel';
import type { Channel } from './types';
import { webhookChannel } from './webhook.channel';

/** One channel per configured destination. Building the email channel opens no connection. */
export const createChannels = (cfg: NotifyConfig): Channel[] => [
  ...(cfg.webhook ? [webhookChannel(cfg.webhook)] : []),
  ...(cfg.slack ? [slackChannel(cfg.slack)] : []),
  ...(cfg.email ? [emailChannel(cfg.email)] : []),
];
