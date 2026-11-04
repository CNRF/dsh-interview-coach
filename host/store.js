import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * JSON file persistence for interviews. Lives outside any single workspace so
 * history survives workspace switches. One file per interview plus an index.
 */
export class InterviewStore {
  constructor(root) {
    this.root = root || process.env.DSH_INTERVIEW_COACH_HOME || path.join(os.homedir(), '.dsh', 'dsh-interview-coach');
    this.dir = path.join(this.root, 'interviews');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  file(id) {
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('invalid interview id');
    return path.join(this.dir, `${id}.json`);
  }

  save(interview) {
    interview.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.file(interview.id), JSON.stringify(interview, null, 2));
  }

  get(id) {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
    } catch {
      return undefined;
    }
  }

  list() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const all = [];
    for (const name of names) {
      try {
        all.push(JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')));
      } catch { /* skip corrupted */ }
    }
    all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return all;
  }

  remove(id) {
    try { fs.unlinkSync(this.file(id)); } catch { /* absent */ }
  }
}

export function newId() {
  return `iv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
