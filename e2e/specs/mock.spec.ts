/** Spec 8: a mock (Pro, here through the trial) answers fetch with its own body. */
import { expect, tag, test } from '../support/fixtures.ts';
import { mock, profile } from '../support/profiles.ts';

test('a mock returns its body to fetch without hitting the server', async ({
  ext,
  echo,
  openHarness,
}) => {
  const body = JSON.stringify({ users: [{ id: 7, name: 'Zoë Ångström', role: 'admin ✓' }] });
  const snap = await ext.apply(profile('Mocks', { mocks: [mock('/echo/api/users', body)] }));
  // Saving the first Pro item starts the free trial.
  expect(snap.pro).toMatchObject({ pro: true, source: 'trial' });

  const page = await openHarness();
  const id = tag('mock');
  const res = await page.evaluate((t) => window.hb.fetch(t, '/echo/api/users'), id);
  expect(res.text).toBe(body);
  expect(JSON.parse(res.text).users[0].name).toBe('Zoë Ångström');
  expect(res.headers['content-type']).toContain('application/json');
  expect(echo.tagged(id)).toHaveLength(0);
});
