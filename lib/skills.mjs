import { createSkillsArchive, collectLocalIntoArchive } from './skills-local.mjs';
import { collectWebSkills } from './skills-web.mjs';

export async function exportSkills({ source = 'all', onProgress = () => {}, signal, ...options } = {}) {
  if (!['all', 'codex', 'claude-code', 'claude-web', 'local'].includes(source)) throw new Error('source: all, local, codex, claude-code или claude-web.');
  const archive = await createSkillsArchive({ ...options, source });
  onProgress({ phase: 'discovering_skills', out: archive.out });
  try {
    if (source !== 'claude-web') await collectLocalIntoArchive(archive, { ...options, source: ['all', 'local'].includes(source) ? 'all' : source, signal, onProgress });
    if (['all', 'claude-web'].includes(source) && !signal?.aborted) await collectWebSkills(archive, { ...options, signal, onProgress });
  } catch (error) { archive.manifest.issues.push({ source, reason: error.code || error.message }); }
  const result = await archive.finish();
  if (signal?.aborted) { result.phase = 'paused'; result.stop_reason = 'user_requested'; }
  onProgress(result);
  return result;
}
