#!/usr/bin/env node

import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseNodeArgs } from 'node:util';

import * as defaultPrompts from '@clack/prompts';
import matter from 'gray-matter';

import { getSkillCategory, skillCategories } from './skill-categories.mjs';
import { runGit } from './update-skills.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), '..');

export function parseArgs(args) {
  const parsed = parseNodeArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      all: { type: 'boolean' },
      skill: { type: 'string', multiple: true },
      category: { type: 'string' },
    },
  });
  if (parsed.positionals.length > 2) throw new Error('最多指定仓库 URL 和项目名称两个位置参数。');
  if (parsed.values.all && parsed.values.skill) throw new Error('--all 和 --skill 不能同时使用。');
  if (parsed.values.category !== undefined) getSkillCategory('所选 Skill', { category: parsed.values.category });
  return parsed;
}

function projectName(value) {
  const name = value.replaceAll('\\', '/').replace(/^sources\//, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.endsWith('.')) {
    throw new Error('项目名称只能包含字母、数字、点、下划线和连字符，以字母或数字开头，不能以点结尾；目录须为 sources/<project-name>。');
  }
  return name;
}

async function exists(filePath) {
  try {
    return await lstat(filePath);
  }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureSource(repoRoot, repositoryUrl, submodule, git, logger) {
  const sourcePath = path.join(repoRoot, submodule);
  for (const candidate of [path.join(repoRoot, 'sources'), sourcePath]) {
    if ((await exists(candidate))?.isSymbolicLink()) throw new Error(`来源目录不能是符号链接：${candidate}`);
  }
  if (await exists(path.join(repoRoot, '.gitmodules'))) {
    const entries = git(['config', '--file', '.gitmodules', '--null', '--list'])
      .split('\0').filter(Boolean).map((entry) => {
        const separator = entry.indexOf('\n');
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      });
    const existing = entries.find(([key, value]) => key.endsWith('.path') && value === submodule);
    if (existing) {
      const urlKey = `${existing[0].slice(0, -4)}url`;
      const existingUrl = entries.find(([key]) => key === urlKey)?.[1];
      if (existingUrl !== repositoryUrl) throw new Error(`${submodule} 的来源 URL 不一致：已登记 ${existingUrl}。`);
      if (!(await exists(path.join(sourcePath, '.git')))) {
        git(['submodule', 'update', '--init', '--', submodule], { stdio: 'inherit' });
      }
      logger.log(`复用已有子模块 ${submodule}，继续扫描和注册。`);
      return sourcePath;
    }
  }
  git(['submodule', 'add', '--', repositoryUrl, submodule], { stdio: 'inherit' });
  logger.log(`子模块添加成功：${submodule}`);
  return sourcePath;
}

export async function discoverSkills(sourcePath, git, logger = console, preferredPaths = {}) {
  const tracked = git(['-C', sourcePath, 'ls-files', '--stage', '-z']);
  const discovered = [];
  for (const entry of tracked.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\t');
    const mode = entry.slice(0, 6);
    const file = entry.slice(separator + 1);
    if (!['100644', '100755'].includes(mode) || path.posix.basename(file) !== 'SKILL.md') continue;
    let data;
    try {
      ({ data } = matter(await readFile(path.join(sourcePath, file), 'utf8')));
      if (typeof data.name !== 'string' || data.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name)) {
        throw new Error('name 必须是最多 64 个字符的小写字母、数字和连字符，且不能以连字符开头或结尾、不能有连续连字符');
      }
      if (typeof data.description !== 'string' || !data.description.trim()) throw new Error('缺少 description');
    }
    catch (error) {
      logger.warn(`跳过 ${file}：${error.message}`);
      continue;
    }
    const skillPath = path.posix.dirname(file);
    discovered.push({ name: data.name, description: data.description, skillPath });
  }
  const skills = [];
  for (const name of new Set(discovered.map(skill => skill.name))) {
    const candidates = discovered.filter(skill => skill.name === name);
    const preferred = candidates.find(skill => skill.skillPath === preferredPaths[name])
      ?? candidates.find(skill => skill.skillPath === `skills/${name}`);
    if (candidates.length > 1 && !preferred) {
      throw new Error(`发现同名 Skill ${name}：${candidates.map(skill => skill.skillPath).join('、')}。无法确定来源目录，请先解决重名。`);
    }
    if (candidates.length > 1) logger.log(`${name} 有多个来源目录，使用 ${preferred.skillPath}。`);
    skills.push(preferred ?? candidates[0]);
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function main(args = process.argv.slice(2), options = {}) {
  const { values, positionals } = parseArgs(args);
  const logger = options.logger ?? console;
  if (values.help) {
    logger.log('用法：pnpm run sources:add [-- <repository-url> [sources/<project-name>] [选项]]');
    logger.log('不带参数时交互输入仓库 URL 和项目名称；添加成功后自动发现并登记 Skill。');
    logger.log('选项：--all（全部注册）、--skill <name>（可重复）、--category <id>、--help/-h');
    logger.log(`分类：${skillCategories.map(category => category.id).join('、')}；默认 other。`);
    return;
  }
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const prompts = options.prompts ?? defaultPrompts;
  const git = options.runGitCommand ?? ((gitArgs, gitOptions) => runGit(gitArgs, { repoRoot, ...gitOptions }));
  async function ask(type, settings) {
    const answer = await prompts[type](settings);
    if (prompts.isCancel(answer)) throw new Error('已取消操作。已添加的子模块会保留，可重新运行 sources:add 继续。');
    return answer;
  }

  let repositoryUrl = positionals[0];
  if (!repositoryUrl) {
    if (!interactive) throw new Error('非交互环境请提供仓库 URL：pnpm run sources:add -- <repository-url>。');
    repositoryUrl = await ask('text', {
      message: '来源仓库 URL：',
      validate: value => !value?.trim() || value.trim().startsWith('-') ? '请输入有效的仓库 URL。' : undefined,
    });
  }
  repositoryUrl = repositoryUrl.trim();
  if (!repositoryUrl || repositoryUrl.startsWith('-') || /[\r\n\0]/.test(repositoryUrl)) throw new Error('仓库 URL 无效。');
  let project = positionals[1];
  if (!project) {
    const suggested = repositoryUrl.replace(/[\\/]+$/, '').split(/[\\/:]/).at(-1).replace(/\.git$/, '');
    project = interactive ? await ask('text', {
      message: '项目名称（保存到 sources/<project-name>）：',
      placeholder: suggested,
      defaultValue: suggested,
      validate(value) {
        try { projectName(value || suggested); }
        catch (error) { return error.message; }
      },
    }) || suggested : suggested;
  }
  const submodule = `sources/${projectName(project.trim())}`;
  const configPath = path.join(repoRoot, 'skills.config.json');
  const original = await readFile(configPath, 'utf8');
  const config = JSON.parse(original);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('skills.config.json 必须是配置对象。');
  const sourcePath = await ensureSource(repoRoot, repositoryUrl, submodule, git, logger);
  const preferredPaths = Object.fromEntries(Object.entries(config)
    .filter(([, entry]) => entry?.submodule === submodule).map(([name, entry]) => [name, entry.skillPath]));
  const skills = await discoverSkills(sourcePath, git, logger, preferredPaths);
  if (skills.length === 0) throw new Error(`在 ${submodule} 中未发现有效的 SKILL.md。子模块已保留，可修正来源后重试。`);
  logger.log(`发现 ${skills.length} 个 Skill。`);

  let selectedNames = values.skill;
  if (selectedNames) {
    const missing = selectedNames.find(name => !skills.some(skill => skill.name === name));
    if (missing) throw new Error(`没有找到 Skill：${missing}`);
  }
  else if (values.all || skills.length === 1) selectedNames = skills.map(skill => skill.name);
  else {
    if (!interactive) throw new Error('发现多个 Skill，请使用 --all 或 --skill <name> 选择要注册的 Skill。');
    selectedNames = await ask('multiselect', {
      message: '选择要注册的 Skill（空格勾选，回车继续）：',
      options: skills.map(skill => {
        const description = skill.description.replace(/\s+/g, ' ').trim();
        return {
          value: skill.name,
          label: skill.name,
          hint: `${skill.skillPath} · ${description.length > 60 ? `${description.slice(0, 60)}…` : description}`,
        };
      }),
      initialValues: skills.map(skill => skill.name),
      required: true,
    });
  }
  const selected = skills.filter(skill => selectedNames.includes(skill.name));
  const additions = [];
  for (const skill of selected) {
    if (Object.hasOwn(config, skill.name)) {
      const existing = config[skill.name];
      if (existing?.submodule !== submodule || existing.skillPath !== skill.skillPath) {
        throw new Error(`Skill 名称冲突：${skill.name} 已登记为其他来源或本地 Skill。`);
      }
      logger.log(`${skill.name} 已登记，保留已有配置。`);
    }
    else {
      if (await exists(path.join(repoRoot, 'skills', skill.name))) throw new Error(`Skill 名称冲突：skills/${skill.name} 已存在，不能覆盖本地 Skill。`);
      additions.push(skill);
    }
  }
  if (additions.length === 0) {
    logger.log('所选 Skill 均已登记，无需修改配置。');
    return;
  }
  const category = values.category ?? (interactive ? await ask('select', {
    message: '为本次新增的 Skill 设置分类：',
    options: skillCategories.map(item => ({ value: item.id, label: item.label })),
    initialValue: 'other',
  }) : 'other');
  getSkillCategory('所选 Skill', { category });
  for (const skill of additions) config[skill.name] = { submodule, skillPath: skill.skillPath, category };
  if (await readFile(configPath, 'utf8') !== original) throw new Error('skills.config.json 在操作期间已变化，请重新运行命令以保留最新配置。');
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  try {
    await rename(temporary, configPath);
  }
  finally {
    await rm(temporary, { force: true });
  }
  logger.log(`已将 ${additions.length} 个 Skill 登记到 skills.config.json：${additions.map(skill => skill.name).join('、')}。`);
  logger.log(`下一步：pnpm run update -- ${additions.map(skill => skill.name).join(' ')}，同步后运行 pnpm run groups:generate 和 pnpm run check。`);
}

/* v8 ignore start -- CLI bootstrap is covered through exported main() */
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
