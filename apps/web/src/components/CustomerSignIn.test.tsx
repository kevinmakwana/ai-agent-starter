// @vitest-environment jsdom
import assert from 'node:assert/strict';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { CustomerSignIn } from './CustomerSignIn';

afterEach(cleanup);

describe('CustomerSignIn', () => {
  it('asks for a link with the typed email and then shows the same neutral message', async () => {
    const request = vi.spyOn(api, 'customerRequestLink').mockResolvedValue({ status: 'ok' });
    render(<CustomerSignIn />);
    await userEvent.type(screen.getByLabelText('Email'), 'ava.brooks@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send me a sign-in link' }));
    assert.deepEqual(request.mock.calls, [['ava.brooks@example.com']]);
    await screen.findByText('Check your inbox');
    // The page must not say whether the address belongs to a customer.
    assert.match(screen.getByText(/If that email belongs to a customer account/).textContent ?? '', /on its way/);
  });

  it('lets the customer go back and try another address', async () => {
    vi.spyOn(api, 'customerRequestLink').mockResolvedValue({ status: 'ok' });
    render(<CustomerSignIn />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send me a sign-in link' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use a different email' }));
    assert.ok(screen.getByRole('button', { name: 'Send me a sign-in link' }));
  });

  it('shows an error when the request fails', async () => {
    vi.spyOn(api, 'customerRequestLink').mockRejectedValue(new Error('Too many requests'));
    render(<CustomerSignIn />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send me a sign-in link' }));
    assert.equal((await screen.findByRole('alert')).textContent, 'Too many requests');
  });
});
