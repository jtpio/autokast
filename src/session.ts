import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ScreencastDefinition, Session } from './types.ts';

export const SESSION_FILE = 'session.json';

/**
 * Reads `session.json` from a session directory.
 */
export async function loadSession(dir: string): Promise<Session> {
  const file = path.join(dir, SESSION_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error(`No session found in "${dir}" (missing ${SESSION_FILE}). Record one first.`);
  }
  const session = JSON.parse(text) as Session;
  if (session.version !== 1) {
    throw new Error(`Unsupported session version ${session.version} in "${file}".`);
  }
  return session;
}

/**
 * Writes `session.json` into a session directory.
 */
export async function saveSession(dir: string, session: Session): Promise<void> {
  await writeFile(path.join(dir, SESSION_FILE), JSON.stringify(session));
}

/**
 * Identity helper that gives type checking to a screencast script.
 */
export function defineScreencast(definition: ScreencastDefinition): ScreencastDefinition {
  return definition;
}
