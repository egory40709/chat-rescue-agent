import { readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { ExportSession } from './session.mjs';
import { atomicWrite } from './archive.mjs';

export async function worker(configFile, { sessionFactory = () => new ExportSession({ controlTransport: 'file-worker' }) } = {}) {
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const session = sessionFactory();
  let exiting = false;
  const close = async () => { exiting = true; await session.close(); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
  try {
    await session.open(config);
    while (!exiting) {
      const directory = join(session.out, '.commands');
      const names = (await readdir(directory)).filter(name => /^\d+-[\w-]+\.json$/.test(name)).sort();
      for (const name of names) {
        const path = join(directory, name);
        const command = JSON.parse(await readFile(path, 'utf8'));
        let response;
        try {
          if (command.session_id !== session.state.session_id) throw new Error('Команда относится к другой сессии.');
          if (command.action === 'continue') response = await session.start({ ...config.initial_options, ...command.options, user_ready: true });
          else if (command.action === 'resume') response = await session.resume({ ...command.options, user_ready: true });
          else if (command.action === 'stop') response = await session.stop();
          else if (command.action === 'pack') response = await session.pack();
          else if (command.action === 'inspect') response = await session.inspect();
          else if (command.action === 'close') { response = await session.close(); exiting = true; }
          else throw new Error('Неизвестная команда.');
        } catch (error) { response = { error: error.message }; }
        await atomicWrite(path + '.result', JSON.stringify(response));
        await rename(path, path + '.done');
        if (exiting) break;
      }
      if (session.contextClosed && !session.job) exiting = true;
      if (!exiting) await new Promise(resolve => setTimeout(resolve, 250));
    }
  } finally {
    await session.close(); process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close);
  }
}
