import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main, parseArgs } from '../../scripts/add-source.mjs';
import { assertInside, runGit } from '../../scripts/update-skills.mjs';

const fixtureRoots = [];

function git(root, args, options = {}) {
  return runGit(args, {
    ...options,
    repoRoot: root,
    env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' },
  });
}

function commit(root) {
  git(root, ['add', '.']);
  git(root, [
    '-c', 'user.name=Tests', '-c', 'user.email=tests@example.com',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'test: 创建来源版本',
  ]);
}

function skill(name, description = `Description of ${name}`) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

async function fixture(files = { 'SKILL.md': skill('alpha') }, config = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skills-add-test-'));
  fixtureRoots.push(root);
  const upstream = path.join(root, 'upstream-project');
  const repoRoot = path.join(root, 'consumer');
  await mkdir(upstream);
  await mkdir(repoRoot);
  git(upstream, ['init', '-b', 'main']);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(upstream, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  commit(upstream);
  git(repoRoot, ['init', '-b', 'main']);
  await writeFile(path.join(repoRoot, 'skills.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  commit(repoRoot);
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const runGitCommand = vi.fn((args, options) => git(repoRoot, args, options));
  return {
    root, upstream, repoRoot, url: upstream.replaceAll('\\', '/'), logger, runGitCommand,
    options: { repoRoot, interactive: false, logger, runGitCommand },
    readConfig: async () => JSON.parse(await readFile(path.join(repoRoot, 'skills.config.json'), 'utf8')),
  };
}

function promptMock(texts = []) {
  const cancelled = Symbol('cancelled');
  const prompts = {
    text: vi.fn(),
    select: vi.fn().mockResolvedValue('development'),
    multiselect: vi.fn().mockResolvedValue(['alpha']),
    isCancel: value => value === cancelled,
  };
  for (const text of texts) prompts.text.mockImplementationOnce(async settings => text || settings.defaultValue || '');
  return { prompts, cancelled };
}

afterEach(async () => {
  for (const root of fixtureRoots.splice(0)) {
    assertInside(os.tmpdir(), root, '测试清理路径');
    await rm(root, { recursive: true, force: true });
  }
});

describe('sources:add', () => {
  it('supports pnpm forwarding, repeated skill selection, and help without side effects', async () => {
    const parsed = parseArgs(['--', 'https://example.com/team/project.git', 'sources/project', '--skill', 'alpha', '--skill', 'beta', '--category', 'development']);
    expect(parsed.positionals).toEqual(['https://example.com/team/project.git', 'sources/project']);
    expect(parsed.values).toMatchObject({ skill: ['alpha', 'beta'], category: 'development' });
    expect(parseArgs(['--all']).values.all).toBe(true);
    expect(parseArgs(['-h']).values.help).toBe(true);
    expect(() => parseArgs(['--unknown'])).toThrow();
    expect(() => parseArgs(['--category'])).toThrow();
    const logger = { log: vi.fn() };
    const runGitCommand = vi.fn();
    await main(['--help'], { logger, runGitCommand });
    expect(logger.log.mock.calls.flat().join('\n')).toContain('sources:add');
    expect(runGitCommand).not.toHaveBeenCalled();
  });

  it('adds a real submodule and automatically registers a root Skill without publishing it', async () => {
    const f = await fixture();
    const head = git(f.repoRoot, ['rev-parse', 'HEAD']);
    await main(['--', f.url, 'sources/example'], f.options);
    expect(await f.readConfig()).toMatchObject({ alpha: { submodule: 'sources/example', skillPath: '.' } });
    expect((await f.readConfig()).alpha.category ?? 'other').toBe('other');
    expect(await readFile(path.join(f.repoRoot, '.gitmodules'), 'utf8')).toContain('sources/example');
    expect(git(f.repoRoot, ['rev-parse', 'HEAD'])).toBe(head);
    await expect(lstat(path.join(f.repoRoot, 'skills', 'alpha'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('collects URL and project interactively and registers only checked Skills with a shared category', async () => {
    const f = await fixture({ 'skills/alpha/SKILL.md': skill('alpha'), 'skills/beta/SKILL.md': skill('beta') });
    const { prompts } = promptMock([f.url, 'interactive-project']);
    await main([], { ...f.options, interactive: true, prompts });
    expect(prompts.text).toHaveBeenCalledTimes(2);
    expect(prompts.multiselect).toHaveBeenCalledOnce();
    expect(prompts.multiselect.mock.calls[0][0].options).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'alpha' }), expect.objectContaining({ value: 'beta' }),
    ]));
    expect(prompts.select).toHaveBeenCalledOnce();
    expect(prompts.multiselect.mock.calls[0][0].initialValues).toEqual(['alpha', 'beta']);
    expect(prompts.select.mock.calls[0][0].initialValue).toBe('other');
    const [urlPrompt, projectPrompt] = prompts.text.mock.calls.map(([settings]) => settings);
    expect(urlPrompt.validate('')).toBeTypeOf('string');
    expect(urlPrompt.validate('-invalid')).toBeTypeOf('string');
    expect(urlPrompt.validate(f.url)).toBeUndefined();
    expect(projectPrompt.validate('')).toBeUndefined();
    expect(projectPrompt.validate('../outside')).toBeTypeOf('string');
    expect(projectPrompt.validate('valid-project')).toBeUndefined();
    expect(await f.readConfig()).toEqual({ alpha: {
      submodule: 'sources/interactive-project', skillPath: 'skills/alpha', category: 'development',
    } });
  });

  it('accepts the inferred project name and auto-selects a single Skill', async () => {
    const f = await fixture();
    const { prompts } = promptMock(['']);
    await main([f.url], { ...f.options, interactive: true, prompts });
    expect(prompts.text).toHaveBeenCalledOnce();
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(await f.readConfig()).toMatchObject({ alpha: { submodule: 'sources/upstream-project' } });
  });

  it('supports a bare project name and non-interactive selection flags', async () => {
    const f = await fixture({ '.agents/skills/alpha/SKILL.md': skill('alpha'), 'skills/beta/SKILL.md': skill('beta') });
    const { prompts } = promptMock();
    await main([f.url, 'selected', '--skill', 'beta', '--category', 'visual-design'], { ...f.options, prompts });
    expect(await f.readConfig()).toEqual({ beta: {
      submodule: 'sources/selected', skillPath: 'skills/beta', category: 'visual-design',
    } });
    expect(prompts.text).not.toHaveBeenCalled();
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(prompts.select).not.toHaveBeenCalled();
    await main([f.url, 'selected', '--all'], f.options);
    expect(await f.readConfig()).toMatchObject({
      alpha: { submodule: 'sources/selected', skillPath: '.agents/skills/alpha' },
      beta: { category: 'visual-design' },
    });
  });

  it('preserves metadata and avoids rewriting an unchanged registration', async () => {
    const config = { alpha: {
      submodule: 'sources/example', skillPath: '.', category: 'diagramming',
      requirements: [{ title: 'External tool', description: 'Keep this description.' }],
    } };
    const f = await fixture(undefined, config);
    const configPath = path.join(f.repoRoot, 'skills.config.json');
    const before = await readFile(configPath, 'utf8');
    await main([f.url, 'sources/example', '--category', 'development'], f.options);
    expect(await readFile(configPath, 'utf8')).toBe(before);
    f.runGitCommand.mockClear();
    await main([f.url, 'sources/example'], f.options);
    expect(await f.readConfig()).toEqual(config);
    expect(f.runGitCommand.mock.calls.some(([args]) => args.includes('add'))).toBe(false);
    await main([f.url, 'sources/example'], { repoRoot: f.repoRoot, interactive: false, logger: f.logger });
    expect(await f.readConfig()).toEqual(config);
  });

  it.each([
    { alpha: { submodule: 'sources/another', skillPath: '.' } },
    { alpha: { category: 'productivity' } },
  ])('rejects name conflicts without overwriting configuration: %j', async (config) => {
    const f = await fixture(undefined, config);
    await expect(main([f.url, 'example'], f.options)).rejects.toThrow(/冲突/);
    expect(await f.readConfig()).toEqual(config);
  });

  it('protects an unconfigured locally maintained Skill directory', async () => {
    const f = await fixture();
    const local = path.join(f.repoRoot, 'skills', 'alpha');
    await mkdir(local, { recursive: true });
    await writeFile(path.join(local, 'SKILL.md'), skill('alpha', 'Local content'));
    await expect(main([f.url, 'example'], f.options)).rejects.toThrow(/冲突/);
    expect(await readFile(path.join(local, 'SKILL.md'), 'utf8')).toContain('Local content');
    expect(await f.readConfig()).toEqual({});
  });

  it('rejects a different URL for an existing submodule', async () => {
    const f = await fixture();
    await main([f.url, 'example'], f.options);
    await expect(main(['https://example.com/other.git', 'example'], f.options)).rejects.toThrow(/来源|URL|不一致/);
    expect(await f.readConfig()).toMatchObject({ alpha: { submodule: 'sources/example' } });
  });

  it('initializes a previously deinitialized source before scanning it again', async () => {
    const f = await fixture();
    await main([f.url, 'example'], f.options);
    git(f.repoRoot, ['submodule', 'deinit', '--force', '--', 'sources/example']);
    await expect(lstat(path.join(f.repoRoot, 'sources', 'example', '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    f.runGitCommand.mockClear();
    await main([f.url, 'example'], f.options);
    expect(f.runGitCommand.mock.calls.some(([args]) => args.includes('--init'))).toBe(true);
    expect(await f.readConfig()).toMatchObject({ alpha: { submodule: 'sources/example' } });
  });

  it('keeps an added submodule after cancellation and completes registration on retry', async () => {
    const f = await fixture({ 'skills/alpha/SKILL.md': skill('alpha'), 'skills/beta/SKILL.md': skill('beta') });
    const { prompts, cancelled } = promptMock();
    prompts.multiselect.mockResolvedValue(cancelled);
    await expect(main([f.url, 'example'], { ...f.options, interactive: true, prompts })).rejects.toThrow(/已取消/);
    expect(await f.readConfig()).toEqual({});
    expect(await readFile(path.join(f.repoRoot, '.gitmodules'), 'utf8')).toContain('sources/example');
    f.runGitCommand.mockClear();
    await main([f.url, 'example', '--all'], f.options);
    expect(Object.keys(await f.readConfig())).toEqual(['alpha', 'beta']);
    expect(f.runGitCommand.mock.calls.some(([args]) => args.includes('add'))).toBe(false);
  });

  it('cancels before adding a source and while choosing a category', async () => {
    const f = await fixture();
    const { prompts, cancelled } = promptMock();
    prompts.text.mockResolvedValue(cancelled);
    await expect(main([], { ...f.options, interactive: true, prompts })).rejects.toThrow(/已取消/);
    expect(f.runGitCommand).not.toHaveBeenCalled();
    prompts.select.mockResolvedValue(cancelled);
    await expect(main([f.url, 'example'], { ...f.options, interactive: true, prompts })).rejects.toThrow(/已取消/);
    expect(await f.readConfig()).toEqual({});
  });

  it('does not register when Git fails to add the source', async () => {
    const f = await fixture();
    const runGitCommand = vi.fn((args, options) => {
      if (args.includes('add')) throw new Error('clone failed');
      return git(f.repoRoot, args, options);
    });
    await expect(main([f.url, 'example'], { ...f.options, runGitCommand })).rejects.toThrow('clone failed');
    expect(await f.readConfig()).toEqual({});
  });

  it('skips malformed and incomplete Skill files while discovering valid hidden paths', async () => {
    const f = await fixture({
      '.agents/skills/alpha/SKILL.md': skill('alpha'),
      'skills/no-name/SKILL.md': '---\ndescription: Missing name\n---\n',
      'skills/no-description/SKILL.md': '---\nname: missing-description\n---\n',
      'skills/invalid-name/SKILL.md': skill('../outside'),
      'skills/broken/SKILL.md': '---\nname: [\n---\n',
      'readme.md': 'This is not a Skill.\n',
    });
    await main([f.url, 'example', '--all'], f.options);
    expect(await f.readConfig()).toMatchObject({ alpha: { skillPath: '.agents/skills/alpha' } });
    expect(Object.keys(await f.readConfig())).toEqual(['alpha']);
    expect(f.logger.warn).toHaveBeenCalled();
    const untracked = path.join(f.repoRoot, 'sources', 'example', 'scratch');
    await mkdir(untracked);
    await writeFile(path.join(untracked, 'SKILL.md'), skill('untracked'));
    await main([f.url, 'example', '--all'], f.options);
    expect(await f.readConfig()).not.toHaveProperty('untracked');
  });

  it('reports no usable Skills and unknown selections without modifying configuration', async () => {
    const f = await fixture({ 'README.md': 'No Skills here.\n' });
    await expect(main([f.url, 'example'], f.options)).rejects.toThrow(/Skill/i);
    expect(await f.readConfig()).toEqual({});
    const valid = await fixture();
    await expect(main([valid.url, 'example', '--skill', 'missing'], valid.options)).rejects.toThrow(/missing/);
    expect(await valid.readConfig()).toEqual({});
  });

  it('rejects duplicate names in the source instead of registering an arbitrary path', async () => {
    const f = await fixture({ 'first/SKILL.md': skill('alpha'), 'second/SKILL.md': skill('alpha') });
    await expect(main([f.url, 'example', '--all'], f.options)).rejects.toThrow(/同名/);
    expect(await f.readConfig()).toEqual({});
  });

  it('prefers a standard Skill directory and preserves an explicitly registered alternative', async () => {
    const f = await fixture({
      'skills/alpha/SKILL.md': skill('alpha'),
      '.claude/skills/alpha/SKILL.md': skill('alpha'),
    });
    await main([f.url, 'example', '--all'], f.options);
    expect(await f.readConfig()).toMatchObject({ alpha: { skillPath: 'skills/alpha' } });
    const existing = { alpha: {
      submodule: 'sources/example', skillPath: '.claude/skills/alpha', category: 'diagramming',
      requirements: [{ title: 'Existing requirement' }],
    } };
    await writeFile(path.join(f.repoRoot, 'skills.config.json'), JSON.stringify(existing));
    await main([f.url, 'example', '--all'], f.options);
    expect(await f.readConfig()).toEqual(existing);
  });

  it('preserves concurrent edits to the registration config', async () => {
    const f = await fixture();
    const configPath = path.join(f.repoRoot, 'skills.config.json');
    const { prompts } = promptMock();
    prompts.select.mockImplementation(async () => {
      await writeFile(configPath, '{"local":{"category":"development"}}\n');
      return 'development';
    });
    await expect(main([f.url, 'example'], { ...f.options, interactive: true, prompts })).rejects.toThrow(/已变化/);
    expect(await f.readConfig()).toEqual({ local: { category: 'development' } });
  });

  it.each(['null', '[]', '"invalid"'])('rejects a non-object config before adding the source: %s', async (source) => {
    const f = await fixture();
    await writeFile(path.join(f.repoRoot, 'skills.config.json'), source);
    await expect(main([f.url, 'example'], f.options)).rejects.toThrow(/配置对象/);
    expect(f.runGitCommand).not.toHaveBeenCalled();
  });

  it('requires explicit selection for multiple Skills in a non-interactive session', async () => {
    const f = await fixture({ 'alpha/SKILL.md': skill('alpha'), 'beta/SKILL.md': skill('beta') });
    await expect(main([f.url, 'example'], f.options)).rejects.toThrow(/--all|--skill/);
    expect(await f.readConfig()).toEqual({});
  });

  it('validates required input, destination, category and selection before adding', async () => {
    const f = await fixture();
    await expect(main([], f.options)).rejects.toThrow(/URL|url|仓库/);
    await expect(main([f.url, '../outside'], f.options)).rejects.toThrow();
    await expect(main([f.url, 'sources/../outside'], f.options)).rejects.toThrow();
    await expect(main([f.url, 'a/b'], f.options)).rejects.toThrow();
    await expect(main([f.url, 'example', '--category', 'unknown'], f.options)).rejects.toThrow(/category|分类/);
    await expect(main([f.url, 'example', '--all', '--skill', 'alpha'], f.options)).rejects.toThrow();
    await expect(main([f.url, 'example', 'extra'], f.options)).rejects.toThrow();
    expect(await f.readConfig()).toEqual({});
    expect(f.runGitCommand).not.toHaveBeenCalled();
  });
});
