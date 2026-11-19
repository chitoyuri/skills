#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as defaultPrompts from "@clack/prompts";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const defaultRepoRoot = path.resolve(scriptDir, "..");

export function runGit(commandArgs, options = {}) {
  const { repoRoot = defaultRepoRoot, ...spawnOptions } = options;
  const result = spawnSync("git", commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    ...spawnOptions,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Git 命令执行失败，退出码：${result.status}`);
  }

  return result.stdout?.trim() ?? "";
}

export function assertInside(parentPath, childPath, label, options = {}) {
  const relativePath = path.relative(parentPath, childPath);
  if (
    (!options.allowEqual && !relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`${label}超出允许范围：${childPath}`);
  }
}

export async function assertSkillExists(
  sourcePath,
  skillName,
  statFile = stat,
) {
  try {
    const skillFile = await statFile(path.join(sourcePath, "SKILL.md"));
    if (!skillFile.isFile()) {
      throw new Error("SKILL.md 不是文件。");
    }
  } catch (error) {
    throw new Error(`没有找到 ${skillName} Skill：${sourcePath}`, {
      cause: error,
    });
  }
}

export function shouldCopySkillFile(candidatePath) {
  return ![".git", ".gitignore"].includes(path.basename(candidatePath));
}

export function buildSubmoduleArgs(repoRoot, submodule) {
  return [
    "-C",
    repoRoot,
    "submodule",
    "update",
    "--init",
    "--remote",
    "--",
    submodule,
  ];
}

export function parseArgs(args, config) {
  const commandArgs = args[0] === "--" ? args.slice(1) : args;
  const allowedOptions = new Set(["--help", "-h", "--all"]);
  const unknownOption = commandArgs.find(
    (arg) => arg.startsWith("-") && !allowedOptions.has(arg),
  );
  if (unknownOption) {
    throw new Error(`不支持的参数：${unknownOption}`);
  }

  const help = commandArgs.includes("--help") || commandArgs.includes("-h");
  const all = commandArgs.includes("--all");
  const skillNames = [
    ...new Set(commandArgs.filter((arg) => !arg.startsWith("-"))),
  ];
  if (all && skillNames.length > 0) {
    throw new Error("--all 不能与指定的 Skill 名称同时使用。");
  }
  const unknownSkill = skillNames.find((skillName) => !Object.hasOwn(config, skillName));
  if (unknownSkill) {
    throw new Error(`没有找到 Skill 配置：${unknownSkill}`);
  }

  return { help, all, skillNames };
}

export async function updateSkill(skillName, config, options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const runGitCommand =
    options.runGitCommand ??
    ((args, gitOptions) => runGit(args, { repoRoot, ...gitOptions }));
  const removePath = options.removePath ?? rm;
  const makeDirectory = options.makeDirectory ?? mkdir;
  const copyPath = options.copyPath ?? cp;
  const ensureSkillExists = options.ensureSkillExists ?? assertSkillExists;
  const logger = options.logger ?? console;
  const submodulePath = path.resolve(repoRoot, config.submodule);
  const sourcePath = path.resolve(submodulePath, config.skillPath);
  const destinationPath = path.resolve(repoRoot, "skills", skillName);

  assertInside(repoRoot, submodulePath, "子模块路径");
  assertInside(submodulePath, sourcePath, "Skill 来源路径", {
    allowEqual: true,
  });
  assertInside(repoRoot, destinationPath, "发布目标路径", {
    allowEqual: false,
  });

  const updatedSubmodules = options.updatedSubmodules ?? new Set();
  if (!updatedSubmodules.has(submodulePath)) {
    runGitCommand(buildSubmoduleArgs(repoRoot, config.submodule), {
      stdio: "inherit",
    });
    updatedSubmodules.add(submodulePath);
  }
  await ensureSkillExists(sourcePath, skillName);

  await removePath(destinationPath, { recursive: true, force: true });
  await makeDirectory(path.dirname(destinationPath), { recursive: true });
  await copyPath(sourcePath, destinationPath, {
    recursive: true,
    force: true,
    filter: shouldCopySkillFile,
  });

  const sourceCommit = runGitCommand([
    "-C",
    submodulePath,
    "rev-parse",
    "--short",
    "HEAD",
  ]);
  logger.log(`已更新 ${skillName}@${sourceCommit} 并同步到 skills/${skillName}。`);
}

export async function main(args = process.argv.slice(2), options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const readTextFile = options.readTextFile ?? readFile;
  const config =
    options.config ??
    JSON.parse(
      await readTextFile(path.join(repoRoot, "skills.config.json"), "utf8"),
    );
  const logger = options.logger ?? console;
  const parsed = parseArgs(args, config);
  const externalNames = Object.keys(config).filter(name => config[name].submodule);

  if (parsed.help) {
    logger.log("用法：pnpm run update [-- <skill-name>... | -- --all]");
    logger.log(`可更新 Skill：${externalNames.join(", ")}`);
    logger.log(
      "无参数时交互选择；指定名称或 --all 直接更新。非交互环境必须指定名称或 --all。",
    );
    return;
  }

  let skillNames = parsed.all ? externalNames : parsed.skillNames;
  if (!parsed.all && skillNames.length === 0) {
    const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive) {
      throw new Error("非交互环境请指定 Skill 名称，或使用 pnpm run update -- --all 更新全部外部 Skills。");
    }
    if (externalNames.length === 0) {
      logger.log("没有可更新的外部 Skill。");
      return;
    }
    const prompts = options.prompts ?? defaultPrompts;
    skillNames = await prompts.multiselect({
      message: "选择要更新的 Skill（空格勾选，回车开始）：",
      options: externalNames.map(name => ({ value: name, label: name, hint: config[name].submodule })),
      initialValues: [],
      required: true,
    });
    if (prompts.isCancel(skillNames)) {
      throw new Error("已取消更新，尚未执行 Git 操作。");
    }
    if (skillNames.length === 0) throw new Error("请至少选择一个 Skill。");
  }

  const updatedSubmodules = new Set();
  const update =
    options.update ??
    ((skillName, skillConfig) =>
      updateSkill(skillName, skillConfig, {
        ...options,
        repoRoot,
        logger,
        updatedSubmodules,
      }));
  let updatedCount = 0;
  for (const skillName of skillNames) {
    const skillConfig = config[skillName];
    if (!skillConfig.submodule) {
      logger.log(`${skillName} 由仓库内维护，没有可更新的子模块来源，已跳过。`);
      continue;
    }
    await update(skillName, skillConfig);
    updatedCount++;
  }
  logger.log(updatedCount > 0 ? `已完成 ${updatedCount} 个 Skill 的更新。` : "没有可更新的外部 Skill。");
}

export function isDirectExecution(argvPath = process.argv[1]) {
  return (
    Boolean(argvPath) && path.resolve(argvPath) === path.resolve(scriptPath)
  );
}

/* v8 ignore start -- CLI bootstrap is covered through exported main() */
if (isDirectExecution()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
