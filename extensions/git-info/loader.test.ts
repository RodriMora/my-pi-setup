import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { Effect } from "effect";
import {
  loadChangedFiles,
  type ChangedFile,
} from "./src/changed-files-view.ts";
import { CommandRunner, type CommandResult } from "./src/process.ts";

interface Invocation {
  args: string[];
  cwd: string;
  result: CommandResult;
}

type RewriteArgs = (args: string[]) => string[];

async function repository(t: TestContext, rootName = "repo") {
  const sandbox = await mkdtemp(join(tmpdir(), "git-info-loader-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, rootName);
  const home = join(sandbox, "home");
  const xdg = join(sandbox, "xdg");
  const hooks = join(sandbox, "empty-hooks");
  await Promise.all([root, home, xdg, hooks].map((path) => mkdir(path)));

  // Deliberately do not inherit GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
  // GIT_CONFIG_*, pathspec flags, diff drivers, or the user's HOME/XDG settings.
  // No mutation of process.env: even concurrent fixtures are isolated.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_DATA_HOME: join(sandbox, "data"),
    TMPDIR: sandbox,
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: sandbox,
  };

  const execute = (args: string[], cwd = root, timeout = 10_000) =>
    new Promise<CommandResult>((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd, env, timeout, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            reject(error);
            return;
          }
          resolve({
            code: typeof error?.code === "number" ? error.code : 0,
            stdout,
            stderr,
          });
        },
      );
    });

  const git = async (...args: string[]) => {
    const result = await execute(args);
    assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  await git("init", "--quiet", "--initial-branch=main", "--template=");
  await git("config", "user.name", "Loader Test");
  await git("config", "user.email", "loader@example.invalid");
  await git("config", "commit.gpgSign", "false");
  await git("config", "core.hooksPath", hooks);
  await git("config", "core.autocrlf", "false");

  const put = async (path: string, contents: string | Uint8Array) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  };
  const stage = () => git("--literal-pathspecs", "add", "--all", "--", ".");
  const commit = async () => {
    await stage();
    await git("commit", "--quiet", "--no-gpg-sign", "-m", "fixture");
  };
  const calls: Invocation[] = [];
  const load = (cwd = root, rewrite: RewriteArgs = (args) => args) =>
    Effect.runPromise(
      loadChangedFiles(cwd).pipe(
        Effect.provideService(CommandRunner, {
          run: (command, args, commandCwd, timeout) =>
            Effect.promise(async () => {
              assert.equal(command, "git", "the loader must not invoke gh/network");
              const actualArgs = rewrite([...args]);
              const result = await execute(actualArgs, commandCwd, timeout);
              calls.push({ args: actualArgs, cwd: commandCwd, result });
              return result;
            }),
        }),
      ),
    );
  return { root, sandbox, git, put, stage, commit, calls, load };
}

function file(files: ChangedFile[] | null, path: string) {
  assert.ok(files, "expected changed files, not a missing repository");
  const matches = files.filter((entry) => entry.path === path);
  assert.equal(matches.length, 1, `expected exactly one entry for ${path}`);
  return matches[0]!;
}

function patch(
  entry: ChangedFile,
  added: string[],
  deleted: string[],
) {
  assert.equal(entry.additions, added.length, `${entry.path}: additions`);
  assert.equal(entry.deletions, deleted.length, `${entry.path}: deletions`);
  assert.deepEqual(
    entry.diff.filter((line) => line.startsWith("+") && !line.startsWith("+++")),
    added.map((line) => `+${line}`),
    `${entry.path}: added lines must belong to this file only`,
  );
  assert.deepEqual(
    entry.diff.filter((line) => line.startsWith("-") && !line.startsWith("---")),
    deleted.map((line) => `-${line}`),
    `${entry.path}: deleted lines must belong to this file only`,
  );
}

function diffCalls(calls: Invocation[]) {
  return calls.filter(({ args }) => args.includes("diff"));
}

test("[id].tsx and i.tsx each preview their own HEAD patch and counts", async (t) => {
  const repo = await repository(t);
  await repo.put("[id].tsx", "bracket before\n");
  await repo.put("i.tsx", "letter before\n");
  await repo.commit();
  await repo.put("[id].tsx", "bracket after\nbracket extra\n");
  await repo.put("i.tsx", "letter after\nletter extra\nletter third\n");

  const files = await repo.load();
  assert.equal(files?.length, 2);
  patch(file(files, "[id].tsx"), ["bracket after", "bracket extra"], ["bracket before"]);
  patch(file(files, "i.tsx"), ["letter after", "letter extra", "letter third"], ["letter before"]);
});

test("pathspec magic prefixes, stars and question marks are literal tracked names", async (t) => {
  const repo = await repository(t);
  const paths = [":(glob)*.txt", "star*.txt", "starX.txt", "question?.txt", "questionX.txt"];
  for (const [index, path] of paths.entries()) await repo.put(path, `before ${index}\n`);
  await repo.commit();
  for (const [index, path] of paths.entries()) {
    await repo.put(path, `after ${index}\nextra ${index}\n`);
  }
  const files = await repo.load();
  assert.equal(files?.length, paths.length);
  for (const [index, path] of paths.entries()) {
    patch(file(files, path), [`after ${index}`, `extra ${index}`], [`before ${index}`]);
  }
  for (const { args } of diffCalls(repo.calls)) {
    assert.ok(args.includes("--literal-pathspecs"));
    assert.ok(args.indexOf("--literal-pathspecs") < args.indexOf("diff"), "literal-pathspecs is a global Git option");
  }
});

test("staged rename preserves its special-character source and overrides diff.renames=false", async (t) => {
  const repo = await repository(t);
  const source = ":(glob)old[1]*?.tsx";
  const destination = "renamed.tsx";
  const before = Array.from({ length: 50 }, (_, index) => `stable line ${index}`);
  await repo.put(source, `${before.join("\n")}\n`);
  await repo.commit();
  await rename(join(repo.root, source), join(repo.root, destination));
  const after = [...before];
  after[25] = "one tiny modification";
  await repo.put(destination, `${after.join("\n")}\n`);
  await repo.stage();
  await repo.git("config", "diff.renames", "false");
  await repo.git("config", "status.renames", "true");
  const status = await repo.git("status", "--porcelain=v1", "-z");
  assert.equal(status, `R  ${destination}\0${source}\0`, "fixture must really be a porcelain rename");

  const files = await repo.load();
  assert.equal(files?.length, 1);
  const entry = file(files, destination);
  patch(entry, ["one tiny modification"], ["stable line 25"]);
  assert.ok(entry.diff.some((line) => line.startsWith("rename from ")));
  assert.ok(entry.diff.some((line) => line.startsWith("rename to ")));
  assert.ok(!entry.diff.some((line) => line.startsWith("new file mode ")));
  for (const { args } of diffCalls(repo.calls)) {
    assert.ok(args.includes("HEAD"));
    assert.ok(args.some((arg) => arg === "--find-renames" || arg.startsWith("--find-renames=")));
    assert.deepEqual(new Set(args.slice(args.indexOf("--") + 1)), new Set([source, destination]));
  }
});

// The index still reports a rename, but the worktree has diverged enough from
// HEAD that the actual HEAD diff has two records: delete source + add target.
for (const binary of [false, true]) {
  test(`all numstat records contribute for a staged rename with ${binary ? "binary" : "text"} replacement`, async (t) => {
    const repo = await repository(t);
    const source = "a-source.txt";
    const destination = "z-target.txt";
    await repo.put(source, "original one\noriginal two\noriginal three\n");
    await repo.commit();
    await rename(join(repo.root, source), join(repo.root, destination));
    await repo.stage();
    await repo.put(destination, binary ? Buffer.from([0, 1, 2, 3]) : "replacement alpha\nreplacement beta\n");
    const status = await repo.git("status", "--porcelain=v1", "-z");
    assert.equal(status, `RM ${destination}\0${source}\0`);

    const files = await repo.load();
    assert.equal(files?.length, 1);
    const entry = file(files, destination);
    if (binary) {
      assert.equal(entry.additions, null, "any binary record makes additions unknown");
      assert.equal(entry.deletions, null, "any binary record makes deletions unknown");
      assert.ok(entry.diff.some((line) => line.includes("Binary files")));
      assert.ok(entry.diff.includes("-original three"));
    } else {
      patch(entry, ["replacement alpha", "replacement beta"], ["original one", "original two", "original three"]);
    }
    const stats = diffCalls(repo.calls).find(({ args }) => args.includes("--numstat"));
    assert.ok(stats);
    const delimiter = stats.args.includes("-z") ? "\0" : "\n";
    const records = stats.result.stdout.split(delimiter).filter(Boolean);
    assert.equal(records.length, 2, "exercise real multi-record numstat");
  });
}

for (const rootName of ["repo  ", "repo\n", "repo \n  "]) {
  test(`root ${JSON.stringify(rootName)} is preserved when loading from a nested cwd`, async (t) => {
    const repo = await repository(t, rootName);
    await repo.put("nested/deeper/file.txt", "old\n");
    await repo.commit();
    await repo.put("nested/deeper/file.txt", "new\n");
    const cwd = join(repo.root, "nested/deeper");
    const files = await repo.load(cwd);
    patch(file(files, "nested/deeper/file.txt"), ["new"], ["old"]);
    for (const call of repo.calls.filter(({ args }) => !args.includes("--show-toplevel"))) {
      assert.equal(call.cwd, repo.root, "remove only rev-parse's final newline");
    }
  });
}

test("ordinary staged, unstaged, deleted, untracked and binary files diff against HEAD", async (t) => {
  const repo = await repository(t);
  for (const path of ["staged.txt", "unstaged.txt", "mixed.txt", "deleted.txt"]) {
    await repo.put(path, `${path} old\n`);
  }
  await repo.put("tracked.bin", Buffer.from([0, 1, 2]));
  await repo.commit();
  await repo.put("staged.txt", "staged new\n");
  await repo.put("mixed.txt", "intermediate index version\n");
  await repo.put("added.txt", "staged addition\n");
  await repo.stage();
  await repo.put("unstaged.txt", "unstaged new\n");
  await repo.put("mixed.txt", "final worktree version\n");
  await rm(join(repo.root, "deleted.txt"));
  await repo.put("untracked.txt", "untracked one\nuntracked two\n");
  await repo.put("tracked.bin", Buffer.from([0, 3, 4]));
  await repo.put("untracked.bin", Buffer.from([0, 5, 6]));

  const files = await repo.load();
  assert.equal(files?.length, 8);
  patch(file(files, "staged.txt"), ["staged new"], ["staged.txt old"]);
  patch(file(files, "unstaged.txt"), ["unstaged new"], ["unstaged.txt old"]);
  patch(file(files, "mixed.txt"), ["final worktree version"], ["mixed.txt old"]);
  patch(file(files, "deleted.txt"), [], ["deleted.txt old"]);
  patch(file(files, "added.txt"), ["staged addition"], []);
  patch(file(files, "untracked.txt"), ["untracked one", "untracked two"], []);
  for (const path of ["tracked.bin", "untracked.bin"]) {
    const entry = file(files, path);
    assert.equal(entry.additions, null);
    assert.equal(entry.deletions, null);
    assert.ok(entry.diff.some((line) => line.includes("Binary files")));
  }
  assert.ok(diffCalls(repo.calls).some(({ args, result }) => args.includes("--no-index") && result.code === 1), "no-index's expected exit 1 is not an error");
});

test("unborn repositories support staged and untracked files without HEAD", async (t) => {
  const repo = await repository(t);
  await repo.put("staged.txt", "staged\n");
  await repo.stage();
  await repo.put("untracked.txt", "untracked\n");
  await repo.put("untracked.bin", Buffer.from([0, 1]));
  await repo.put("empty.txt", "");
  const files = await repo.load();
  assert.equal(files?.length, 4);
  patch(file(files, "empty.txt"), [], []);
  patch(file(files, "staged.txt"), ["staged"], []);
  patch(file(files, "untracked.txt"), ["untracked"], []);
  assert.equal(file(files, "untracked.bin").additions, null);
  assert.equal(file(files, "untracked.bin").deletions, null);
});

test("clean repositories return an empty list", async (t) => {
  const repo = await repository(t);
  await repo.put("clean.txt", "unchanged\n");
  await repo.commit();
  assert.deepEqual(await repo.load(), []);
});

test("patch and numstat disable external diffs and text conversion, including no-index", async (t) => {
  const repo = await repository(t);
  const marker = join(repo.sandbox, "driver-invoked");
  const driver = join(repo.sandbox, "driver.sh");
  await writeFile(driver, `#!/bin/sh\nprintf invoked > '${marker}'\nprintf 'converted output\\n'\n`, { mode: 0o700 });
  await repo.put(".gitattributes", "*.txt diff=fixture\n");
  await repo.put("tracked.txt", "raw old\n");
  await repo.commit();
  await repo.git("config", "diff.fixture.textconv", driver);
  await repo.git("config", "diff.external", driver);
  await repo.put("tracked.txt", "raw new\n");
  await repo.put("untracked.txt", "raw untracked\n");

  const files = await repo.load();
  patch(file(files, "tracked.txt"), ["raw new"], ["raw old"]);
  patch(file(files, "untracked.txt"), ["raw untracked"], []);
  for (const { args } of diffCalls(repo.calls)) {
    assert.ok(args.includes("--no-ext-diff"), "external diffs disabled for patch AND stats");
    assert.ok(args.includes("--no-textconv"), "textconv disabled for patch AND stats");
  }
  await assert.rejects(stat(marker), { code: "ENOENT" });
});

for (const numstat of [false, true]) {
  test(`no-index ${numstat ? "numstat" : "patch"} missing-file exit 1 is not an empty success`, async (t) => {
    const repo = await repository(t);
    await repo.put("base.txt", "before\n");
    await repo.commit();
    await repo.put("new.txt", "untracked\n");
    const rewrite: RewriteArgs = (args) => {
      if (args.includes("diff") && args.includes("--numstat") === numstat) {
        args[args.length - 1] = "missing-file";
      }
      return args;
    };
    await assert.rejects(repo.load(repo.root, rewrite), /missing-file/);
    const failed = repo.calls.find(({ args }) => args.at(-1) === "missing-file");
    assert.equal(failed?.result.code, 1);
    assert.equal(failed?.result.stdout, "");
  });

  for (const untracked of [false, true]) {
    test(`${untracked ? "no-index" : "tracked"} ${numstat ? "numstat" : "patch"} nonzero failures are surfaced`, async (t) => {
      const repo = await repository(t);
      await repo.put("base.txt", "before\n");
      await repo.commit();
      await repo.put(untracked ? "new.txt" : "base.txt", "after\n");
      // Still execute real Git: make only the selected command fail with usage
      // exit 129, not the legitimate --no-index exit 1 for a differing file.
      const rewrite: RewriteArgs = (args) => {
        if (args.includes("diff") && args.includes("--numstat") === numstat) {
          args.splice(args.indexOf("diff") + 1, 0, "--git-info-test-invalid-option");
        }
        return args;
      };
      await assert.rejects(repo.load(repo.root, rewrite), /git|diff|stat|129/i);
      const failed = repo.calls.find(({ args }) => args.includes("--git-info-test-invalid-option"));
      assert.ok(failed);
      assert.equal(failed.result.code, 129);
      assert.notEqual(failed.result.stderr, "");
    });
  }
}
