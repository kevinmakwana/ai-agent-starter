// @vitest-environment jsdom
import assert from 'node:assert/strict';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, vi } from 'vitest';
import { api, ApiError } from '@/lib/api';
import type { Reviewer } from '@/lib/types';
import { LoginForm } from './LoginForm';

afterEach(cleanup);

const reviewer: Reviewer = {
  id: 'r1',
  email: 'rae@example.com',
  name: 'Rae',
  role: 'reviewer',
  active: true,
  createdAt: '2026-10-31T00:00:00Z',
  lastLoginAt: null,
};

describe('LoginForm', () => {
  it('keeps the button disabled until both fields are filled', async () => {
    render(<LoginForm notice={null} onSignedIn={() => undefined} />);
    const button = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;
    assert.equal(button.disabled, true);
    await userEvent.type(screen.getByLabelText('Email'), 'rae@example.com');
    assert.equal(button.disabled, true);
    await userEvent.type(screen.getByLabelText('Password'), 'a long passphrase');
    assert.equal(button.disabled, false);
  });

  it('signs in with the typed credentials and hands the reviewer to the caller', async () => {
    const login = vi.spyOn(api, 'login').mockResolvedValue({ reviewer });
    const seen: Reviewer[] = [];
    render(<LoginForm notice={null} onSignedIn={(r) => seen.push(r)} />);
    await userEvent.type(screen.getByLabelText('Email'), 'rae@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'a long passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    assert.deepEqual(login.mock.calls, [['rae@example.com', 'a long passphrase']]);
    assert.deepEqual(seen, [reviewer]);
  });

  it('shows the error and clears the password after a failed sign-in', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError('Invalid email or password', 401));
    render(<LoginForm notice={null} onSignedIn={() => assert.fail('must not sign in')} />);
    await userEvent.type(screen.getByLabelText('Email'), 'rae@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    assert.equal((await screen.findByRole('alert')).textContent, 'Invalid email or password');
    assert.equal((screen.getByLabelText('Password') as HTMLInputElement).value, '');
  });

  it('shows the notice it was given, such as an ended session', () => {
    render(<LoginForm notice="Your session ended" onSignedIn={() => undefined} />);
    assert.equal(screen.getByRole('alert').textContent, 'Your session ended');
  });
});
