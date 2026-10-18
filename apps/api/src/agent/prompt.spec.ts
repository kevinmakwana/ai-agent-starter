import { promptVersion } from './prompt';
import { toolSpecs } from './tools';

describe('promptVersion', () => {
  it('is a short, stable hex id', () => {
    expect(promptVersion()).toMatch(/^[0-9a-f]{8}$/);
    expect(promptVersion()).toBe(promptVersion());
  });

  it('changes when a tool description or the system prompt changes, so traces from different prompts are never confused', () => {
    const base = promptVersion();
    const tools = toolSpecs();
    tools[0] = { ...tools[0], description: `${tools[0].description} (edited)` };
    expect(promptVersion(tools)).not.toBe(base);
    expect(promptVersion(toolSpecs(), 'You are a different agent.')).not.toBe(base);
  });

  it('does not depend on who the conversation is with', () => {
    // the fingerprint covers the template, not the per-customer text, or every customer would get their own version
    expect(promptVersion()).toBe(promptVersion(toolSpecs()));
  });
});
