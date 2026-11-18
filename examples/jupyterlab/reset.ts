import type { Page } from 'playwright';

/**
 * Files that the example screencasts create.
 */
const CREATED = ['weather-analysis.ipynb'];

/**
 * Brings a JupyterLab server back to a known state so that a recording repeats:
 * stops the kernels, deletes untitled notebooks, the files that the examples create
 * and `files`, restores the default theme.
 * The page must already be on the server, because the API needs its XSRF cookie.
 */
export async function resetJupyterLab(
  page: Page,
  baseUrl: string,
  files: string[] = [],
): Promise<void> {
  const cookies = await page.context().cookies(baseUrl);
  const headers = { 'X-XSRFToken': cookies.find((cookie) => cookie.name === '_xsrf')?.value ?? '' };
  const api = page.request;
  const options = { headers, failOnStatusCode: false };

  const sessions = await (await api.get(`${baseUrl}/api/sessions`)).json();
  for (const session of sessions) {
    await api.delete(`${baseUrl}/api/sessions/${session.id}`, options);
  }

  const root = await (await api.get(`${baseUrl}/api/contents`)).json();
  const untitled = root.content
    .map((item: { name: string }) => item.name)
    .filter((name: string) => /^Untitled\d*\.ipynb$/.test(name));
  for (const name of [...untitled, ...CREATED, ...files]) {
    await api.delete(`${baseUrl}/api/contents/${encodeURIComponent(name)}`, options);
  }

  await api.put(`${baseUrl}/lab/api/settings/@jupyterlab/apputils-extension:themes`, {
    ...options,
    data: { raw: '{}' },
  });
}
