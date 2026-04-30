export async function clickFirstVisible(locator, { timeout = 15000 } = {}) {
  const target = locator.first();

  await target.click({ timeout, delay: 40 });
}

export async function fillFirstVisible(
  locator,
  value,
  { timeout = 15000 } = {},
) {
  const target = locator.first();

  await target.fill("", { timeout });
  await target.fill(String(value ?? ""), { timeout });
}

export async function tryClickAny(label, attempts) {
  for (const fn of attempts) {
    try {
      await fn();
      return true;
    } catch (err) {
      continue;
    }
  }
  throw new Error(
    `CRITICAL: Could not select required option: ${label}. All fallback locators failed.`,
  );
}
