import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assertInside,
  assertSkillExists,
  buildSubmoduleArgs,
  isDirectExecution,
  main,
  parseArgs,
  runGit,
  shouldCopySkillFile,
  updateSkill,
} from "../../scripts/update-skills.mjs";

function git(root, args) {
  return runGit(args, {
    repoRoot: root,
    env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" },
  });
}

function commitFixture(root) {
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Tests",
    "-c",
    "user.email=tests@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "test: 创建测试版本",
  ]);
}

describe("update-skills", () => {
  it("parses full, selected, help and invalid arguments", () => {
    const config = { alpha: {}, beta: {} };
    expect(parseArgs([], config)).toEqual({
      help: false,
      all: false,
      skillNames: [],
    });
    expect(parseArgs(["alpha", "alpha"], config)).toEqual({
      help: false,
      all: false,
      skillNames: ["alpha"],
    });
    expect(parseArgs(["--", "--all"], config)).toMatchObject({ all: true });
    expect(() => parseArgs(["--all", "alpha"], config)).toThrow(/--all/);
    expect(parseArgs(["--help"], config).help).toBe(true);
    expect(parseArgs(["-h"], config).help).toBe(true);
    expect(() => parseArgs(["--wat"], config)).toThrow("不支持的参数：--wat");
    expect(() => parseArgs(["--update"], config)).toThrow("不支持的参数：--update");
    expect(() => parseArgs(["-u"], config)).toThrow("不支持的参数：-u");
    expect(() => parseArgs(["missing"], config)).toThrow(
      "没有找到 Skill 配置：missing",
    );
    expect(() => parseArgs(["constructor"], config)).toThrow(
      "没有找到 Skill 配置：constructor",
    );
  });

  it("always updates submodules from the remote", () => {
    expect(buildSubmoduleArgs("/repo", "sources/alpha")).toEqual([
      "-C",
      "/repo",
      "submodule",
      "update",
      "--init",
      "--remote",
      "--",
      "sources/alpha",
    ]);
  });

  it("allows equal and dotted sibling names but rejects actual traversal", () => {
    const root = path.resolve("repo");
    expect(() =>
      assertInside(root, root, "根目录", { allowEqual: true }),
    ).not.toThrow();
    expect(() => assertInside(root, root, "根目录")).toThrow("超出允许范围");
    expect(() =>
      assertInside(root, path.join(root, "..folder"), "目录"),
    ).not.toThrow();
    expect(() =>
      assertInside(root, path.resolve(root, "..", "outside"), "目录"),
    ).toThrow("超出允许范围");
  });

  it("validates SKILL.md and preserves only publishable files", async () => {
    await expect(
      assertSkillExists("/source", "alpha", async () => ({
        isFile: () => true,
      })),
    ).resolves.toBeUndefined();
    await expect(
      assertSkillExists("/source", "alpha", async () => ({
        isFile: () => false,
      })),
    ).rejects.toThrow("没有找到 alpha Skill");
    await expect(
      assertSkillExists("/source", "alpha", async () => {
        throw new Error("missing");
      }),
    ).rejects.toThrow("没有找到 alpha Skill");
    expect(shouldCopySkillFile("/source/.git")).toBe(false);
    expect(shouldCopySkillFile("/source/.gitignore")).toBe(false);
    expect(shouldCopySkillFile("/source/SKILL.md")).toBe(true);
  });

  it("updates one skill through injected side effects", async () => {
    const repoRoot = path.resolve("fixture-repo");
    const calls = [];
    const runGitCommand = vi.fn((args) => {
      calls.push(args);
      return args.includes("rev-parse") ? "abc1234" : "";
    });
    const removePath = vi.fn();
    const makeDirectory = vi.fn();
    const copyPath = vi.fn();
    const ensureSkillExists = vi.fn();
    const logger = { log: vi.fn() };

    await updateSkill(
      "alpha",
      { submodule: "sources/project", skillPath: "skills/alpha" },
      {
        repoRoot,
        runGitCommand,
        removePath,
        makeDirectory,
        copyPath,
        ensureSkillExists,
        logger,
      },
    );

    expect(calls[0]).toContain("--remote");
    expect(calls[1]).toEqual([
      "-C",
      path.join(repoRoot, "sources/project"),
      "rev-parse",
      "--short",
      "HEAD",
    ]);
    expect(ensureSkillExists).toHaveBeenCalledWith(
      path.join(repoRoot, "sources/project", "skills/alpha"),
      "alpha",
    );
    expect(removePath).toHaveBeenCalledWith(
      path.join(repoRoot, "skills", "alpha"),
      { recursive: true, force: true },
    );
    expect(makeDirectory).toHaveBeenCalledWith(path.join(repoRoot, "skills"), {
      recursive: true,
    });
    expect(copyPath.mock.calls[0][2].filter("/tmp/.git")).toBe(false);
    expect(logger.log).toHaveBeenCalledWith(
      "已更新 alpha@abc1234 并同步到 skills/alpha。",
    );
  });

  it("rejects unsafe source and destination configuration", async () => {
    const repoRoot = path.resolve("fixture-repo");
    await expect(
      updateSkill("alpha", { submodule: "../outside", skillPath: "." }, {
        repoRoot,
      }),
    ).rejects.toThrow("子模块路径超出允许范围");
    await expect(
      updateSkill(
        "alpha",
        { submodule: "sources/project", skillPath: "../../outside" },
        {
          repoRoot,
        },
      ),
    ).rejects.toThrow("Skill 来源路径超出允许范围");
    await expect(
      updateSkill("..", { submodule: "sources/project", skillPath: "." }, {
        repoRoot,
      }),
    ).rejects.toThrow("发布目标路径超出允许范围");
  });

  it("prints help or invokes selected skills through main", async () => {
    const logger = { log: vi.fn() };
    const update = vi.fn();
    const config = {
      alpha: { submodule: "sources/a" },
      beta: { submodule: "sources/b" },
      gamma: { requirements: [] },
    };

    await main(["--help"], { config, logger, update });
    expect(logger.log).toHaveBeenCalledTimes(3);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringMatching(/用法.*pnpm run update.*--all/),
    );
    expect(update).not.toHaveBeenCalled();

    await main(["beta"], { config, logger, update });
    expect(update).toHaveBeenCalledWith("beta", config.beta);
  });

  it("skips repo-maintained skills without a submodule", async () => {
    const logger = { log: vi.fn() };
    const update = vi.fn();
    const config = {
      alpha: { submodule: "sources/a" },
      gamma: { requirements: [] },
    };

    await main(["--all"], { config, logger, update });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("alpha", config.alpha);

    await main(["gamma"], { config, logger, update });
    expect(logger.log).toHaveBeenCalledWith(
      "gamma 由仓库内维护，没有可更新的子模块来源，已跳过。",
    );
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("offers an initially empty external Skill menu and updates only checked entries", async () => {
    const config = {
      alpha: { submodule: "sources/shared", skillPath: "skills/alpha" },
      beta: { submodule: "sources/shared", skillPath: "skills/beta" },
      local: { category: "development" },
    };
    const update = vi.fn();
    const prompts = {
      multiselect: vi.fn().mockResolvedValue(["beta"]),
      isCancel: () => false,
    };
    await main([], { config, update, prompts, interactive: true, logger: { log: vi.fn() } });
    expect(prompts.multiselect).toHaveBeenCalledOnce();
    const menu = prompts.multiselect.mock.calls[0][0];
    expect(menu.initialValues).toEqual([]);
    expect(menu.required).toBe(true);
    expect(menu.options).toEqual([
      expect.objectContaining({ value: "alpha", hint: "sources/shared" }),
      expect.objectContaining({ value: "beta", hint: "sources/shared" }),
    ]);
    expect(update).toHaveBeenCalledExactlyOnceWith("beta", config.beta);
  });

  it("does not fetch or publish anything when the selection is cancelled", async () => {
    const cancelled = Symbol("cancelled");
    const update = vi.fn();
    const runGitCommand = vi.fn();
    const prompts = {
      multiselect: vi.fn().mockResolvedValue(cancelled),
      isCancel: value => value === cancelled,
    };
    await expect(main([], {
      config: { alpha: { submodule: "sources/a", skillPath: "." } },
      prompts, interactive: true, update, runGitCommand, logger: { log: vi.fn() },
    })).rejects.toThrow(/已取消更新/);
    expect(update).not.toHaveBeenCalled();
    expect(runGitCommand).not.toHaveBeenCalled();
  });

  it("rejects an empty selection without starting an update", async () => {
    const update = vi.fn();
    const prompts = { multiselect: vi.fn().mockResolvedValue([]), isCancel: () => false };
    await expect(main([], {
      config: { alpha: { submodule: "sources/a" } },
      interactive: true, prompts, update, logger: { log: vi.fn() },
    })).rejects.toThrow(/至少选择一个 Skill/);
    expect(update).not.toHaveBeenCalled();
  });

  it("requires explicit names or --all without an interactive terminal", async () => {
    const update = vi.fn();
    const runGitCommand = vi.fn();
    const prompts = { multiselect: vi.fn() };
    await expect(main([], {
      config: { alpha: { submodule: "sources/a" } },
      interactive: false, update, runGitCommand, prompts, logger: { log: vi.fn() },
    })).rejects.toThrow(/--all/);
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(runGitCommand).not.toHaveBeenCalled();
  });

  it.each([{}, { local: { category: "development" } }])("finishes without prompting when no external Skills are configured: %j", async (config) => {
    const update = vi.fn();
    const logger = { log: vi.fn() };
    const prompts = { multiselect: vi.fn() };
    await main([], { config, interactive: true, prompts, update, logger });
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/外部 Skill/));
  });

  it("bypasses menus for --all and explicit names even in an interactive terminal", async () => {
    const config = {
      alpha: { submodule: "sources/a" },
      beta: { submodule: "sources/b" },
      local: { category: "development" },
    };
    const update = vi.fn();
    const logger = { log: vi.fn() };
    const prompts = { multiselect: vi.fn() };
    await main(["--", "--all"], { config, interactive: true, prompts, update, logger });
    expect(update.mock.calls.map(([name]) => name)).toEqual(["alpha", "beta"]);
    update.mockClear();
    await main(["beta", "beta"], { config, interactive: true, prompts, update, logger });
    expect(update).toHaveBeenCalledExactlyOnceWith("beta", config.beta);
    expect(prompts.multiselect).not.toHaveBeenCalled();
  });

  it("updates only the selected skill with pnpm's forwarded argument separator", async () => {
    const config = {
      alpha: { submodule: "sources/a" },
      beta: { submodule: "sources/b" },
    };
    const update = vi.fn();

    await main(["--", "beta"], { config, update, logger: { log: vi.fn() } });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("beta", config.beta);
  });

  it("reads configuration and uses the default update adapter", async () => {
    const readTextFile = vi
      .fn()
      .mockResolvedValue('{"alpha":{"submodule":"sources/a","skillPath":"."}}');
    const runGitCommand = vi.fn((args) =>
      args.includes("rev-parse") ? "deadbee" : "",
    );
    const logger = { log: vi.fn() };
    await main(["alpha"], {
      repoRoot: path.resolve("repo"),
      readTextFile,
      runGitCommand,
      removePath: vi.fn(),
      makeDirectory: vi.fn(),
      copyPath: vi.fn(),
      ensureSkillExists: vi.fn(),
      logger,
    });
    expect(readTextFile).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledWith(
      "已更新 alpha@deadbee 并同步到 skills/alpha。",
    );
  });

  it("fetches a newer upstream commit and replaces published files without committing", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "skills-update-test-"));
    const upstreamRoot = path.join(fixtureRoot, "upstream");
    const repoRoot = path.join(fixtureRoot, "consumer");

    try {
      await mkdir(upstreamRoot);
      await mkdir(repoRoot);
      git(upstreamRoot, ["init", "-b", "main"]);
      await writeFile(path.join(upstreamRoot, "SKILL.md"), "版本 A\n");
      commitFixture(upstreamRoot);

      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["submodule", "add", "-b", "main", upstreamRoot, "sources/alpha"]);
      const destination = path.join(repoRoot, "skills", "alpha");
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, "SKILL.md"), "版本 A\n");
      await writeFile(path.join(destination, "obsolete.txt"), "过期文件\n");
      commitFixture(repoRoot);
      const recordedCommit = git(repoRoot, ["rev-parse", "HEAD"]);
      const recordedPointer = git(repoRoot, ["ls-files", "--stage", "sources/alpha"]);

      await writeFile(path.join(upstreamRoot, "SKILL.md"), "版本 B\n");
      commitFixture(upstreamRoot);
      const latestCommit = git(upstreamRoot, ["rev-parse", "HEAD"]);

      await main(["alpha"], {
        repoRoot,
        config: { alpha: { submodule: "sources/alpha", skillPath: "." } },
        runGitCommand: (args) => git(repoRoot, args),
        logger: { log: vi.fn() },
      });

      const submoduleRoot = path.join(repoRoot, "sources", "alpha");
      expect(git(submoduleRoot, ["rev-parse", "HEAD"])).toBe(latestCommit);
      const publishedContent = await readFile(path.join(destination, "SKILL.md"), "utf8");
      expect(publishedContent.trim()).toBe("版本 B");
      expect(publishedContent).toBe(await readFile(path.join(submoduleRoot, "SKILL.md"), "utf8"));
      await expect(readFile(path.join(destination, "obsolete.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(path.join(destination, ".git"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(git(repoRoot, ["rev-parse", "HEAD"])).toBe(recordedCommit);
      expect(git(repoRoot, ["ls-files", "--stage", "sources/alpha"])).toBe(recordedPointer);
      expect(git(repoRoot, ["diff", "--name-only"])).toContain("sources/alpha");
    } finally {
      assertInside(os.tmpdir(), fixtureRoot, "测试清理路径");
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 15000);

  it("fetches a shared source once per invocation and publishes only selected Skills", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "skills-update-shared-test-"));
    const upstreamRoot = path.join(fixtureRoot, "upstream");
    const repoRoot = path.join(fixtureRoot, "consumer");
    const names = ["alpha", "beta", "gamma"];
    const config = Object.fromEntries(names.map(name => [name, {
      submodule: "sources/shared", skillPath: `skills/${name}`,
    }]));

    try {
      await mkdir(upstreamRoot);
      await mkdir(repoRoot);
      git(upstreamRoot, ["init", "-b", "main"]);
      for (const name of names) {
        await mkdir(path.join(upstreamRoot, "skills", name), { recursive: true });
        await writeFile(path.join(upstreamRoot, "skills", name, "SKILL.md"), `${name} A\n`);
      }
      commitFixture(upstreamRoot);
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["submodule", "add", "-b", "main", upstreamRoot, "sources/shared"]);
      for (const name of names) {
        await mkdir(path.join(repoRoot, "skills", name), { recursive: true });
        await writeFile(path.join(repoRoot, "skills", name, "SKILL.md"), `${name} A\n`);
      }
      commitFixture(repoRoot);
      for (const name of names) {
        await writeFile(path.join(upstreamRoot, "skills", name, "SKILL.md"), `${name} B\n`);
      }
      commitFixture(upstreamRoot);
      const latestCommit = git(upstreamRoot, ["rev-parse", "HEAD"]);
      const runGitCommand = vi.fn(args => git(repoRoot, args));
      const options = { repoRoot, config, runGitCommand, logger: { log: vi.fn() } };
      await main(["alpha", "beta"], options);

      expect(runGitCommand.mock.calls.filter(([args]) => args.includes("--remote"))).toHaveLength(1);
      expect(git(path.join(repoRoot, "sources", "shared"), ["rev-parse", "HEAD"])).toBe(latestCommit);
      for (const name of ["alpha", "beta"]) {
        expect((await readFile(path.join(repoRoot, "skills", name, "SKILL.md"), "utf8")).trim()).toBe(`${name} B`);
      }
      expect((await readFile(path.join(repoRoot, "skills", "gamma", "SKILL.md"), "utf8")).trim()).toBe("gamma A");

      await writeFile(path.join(upstreamRoot, "skills", "beta", "SKILL.md"), "beta C\n");
      commitFixture(upstreamRoot);
      await main(["beta"], options);
      expect(runGitCommand.mock.calls.filter(([args]) => args.includes("--remote"))).toHaveLength(2);
      expect((await readFile(path.join(repoRoot, "skills", "beta", "SKILL.md"), "utf8")).trim()).toBe("beta C");
      expect((await readFile(path.join(repoRoot, "skills", "alpha", "SKILL.md"), "utf8")).trim()).toBe("alpha B");
      expect((await readFile(path.join(repoRoot, "skills", "gamma", "SKILL.md"), "utf8")).trim()).toBe("gamma A");
    } finally {
      assertInside(os.tmpdir(), fixtureRoot, "测试清理路径");
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 15000);

  it("wraps git success, non-zero status and process errors", () => {
    expect(runGit(["--version"])).toMatch(/^git version/);
    expect(() => runGit(["definitely-not-a-command"])).toThrow(
      "Git 命令执行失败",
    );
    expect(() => runGit(["--version"], { repoRoot: "\0invalid" })).toThrow();
  });

  it("recognizes direct execution paths", () => {
    expect(isDirectExecution()).toBe(false);
    expect(isDirectExecution("/definitely/not/the/script.mjs")).toBe(false);
  });
});
