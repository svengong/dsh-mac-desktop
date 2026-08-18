#!/usr/bin/env node
'use strict'

/**
 * One-command release helper.
 *
 * Decides whether a new version is needed and publishes it:
 *
 *  1. analysis: what changed since the last v* tag (conventional-commit
 *     types) -> suggested bump (breaking= major, feat= minor, fix/perf/
 *     refactor= patch, docs/test/ci only = no bump);
 *  2. published check: is v<package.json version> already on origin?
 *     yes -> bump a new version; no -> publish the current version as-is;
 *  3. execute: npm version <type> (auto commit + tag), push main, push
 *     the tag -> the GitHub Actions release workflow takes over.
 *
 * Usage: node scripts/release.js [--dry-run] [--yes] [--bump major|minor|patch]
 *   --dry-run   analyze and print the plan, change nothing
 *   --yes       skip the confirmation prompt
 *   --bump      force a bump type instead of inferring from commits
 */

const path = require('node:path')
const { execSync } = require('node:child_process')

function sh(command, opts) {
  opts = opts || {}
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    if (opts.allowFail) return ''
    const detail = error.stderr ? error.stderr.toString() : error.message
    throw new Error('command failed: ' + command + '\n' + detail)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const yes = args.includes('--yes')
  const bumpIndex = args.indexOf('--bump')
  const forcedBump = bumpIndex >= 0 ? args[bumpIndex + 1] : ''
  if (forcedBump !== '' && !['major', 'minor', 'patch'].includes(forcedBump)) {
    console.error('invalid --bump: ' + forcedBump + ' (expected major|minor|patch)'); process.exit(2)
  }

  const pkg = require(path.join(__dirname, '..', 'package.json'))

  // ── 1. preconditions ────────────────────────────────────────────────

  const dirty = sh('git status --porcelain').split('\n').filter(function (line) { return line !== '' && !line.startsWith('??') })
  if (dirty.length > 0) {
    console.error('工作区有未提交的改动（跟踪文件），请先提交或 stash：')
    for (const line of dirty) console.error('  ' + line)
    process.exit(1)
  }

  const currentVersion = pkg.version
  const currentTag = 'v' + currentVersion

  const localHead = sh('git rev-parse HEAD')
  const remoteHead = sh('git ls-remote origin refs/heads/main', { allowFail: true }).split(/\s+/)[0] || ''
  if (remoteHead !== '' && remoteHead !== localHead) {
    console.error('本地 main 与 origin/main 不一致（需要先 git pull 或 git push）。')
    console.error('  local : ' + localHead.slice(0, 12))
    console.error('  origin: ' + remoteHead.slice(0, 12))
    process.exit(1)
  }

  // ── 2. what changed since the last tag ──────────────────────────────

  const lastTag = sh("git tag -l 'v*' --sort=-v:refname | head -1", { allowFail: true }) || ''
  const commits = lastTag !== ''
    ? sh('git log --format=%s ' + lastTag + '..HEAD').split('\n').filter(Boolean)
    : []

  const types = { breaking: [], feat: [], fix: [], other: [] }
  for (const line of commits) {
    if (/^[a-z]+!:/.test(line) || /BREAKING CHANGE/.test(line)) types.breaking.push(line)
    else if (/^feat(\(|:)/.test(line)) types.feat.push(line)
    else if (/^(fix|perf|refactor|revert)(\(|:)/.test(line)) types.fix.push(line)
    else types.other.push(line)
  }

  let bumpType = forcedBump
  if (bumpType === '') {
    if (types.breaking.length > 0) bumpType = 'major'
    else if (types.feat.length > 0) bumpType = 'minor'
    else if (types.fix.length > 0) bumpType = 'patch'
    else bumpType = 'none'
  }

  // ── 3. is the current version already published? ────────────────────

  const tagExists = sh('git ls-remote origin refs/tags/' + currentTag, { allowFail: true }) !== ''

  // ── 4. plan ─────────────────────────────────────────────────────────

  console.log('当前版本：' + currentVersion + '（' + (tagExists ? 'tag ' + currentTag + ' 已在远端（已发布或发布流程已触发）' : 'tag ' + currentTag + ' 未发布') + '）')
  console.log('上次标签：' + (lastTag || '（无）'))
  console.log('标签后提交：' + commits.length + ' 个')
  console.log('')
  if (commits.length > 0) {
    console.log('  breaking : ' + types.breaking.length)
    console.log('  feat     : ' + types.feat.length)
    console.log('  fix/perf : ' + types.fix.length)
    console.log('  other    : ' + types.other.length)
    for (const line of types.other.slice(0, 5)) console.log('    · ' + line)
  } else {
    console.log('  （自上次标签以来没有新提交）')
  }

  let action = ''
  let newTag = ''
  if (commits.length === 0) {
    if (tagExists) {
      action = 'nothing'
      console.log('\n结论：' + currentTag + ' 已发布且没有新提交，无需发布。')
    } else {
      action = 'publish-current'
      newTag = currentTag
      console.log('\n结论：' + currentTag + ' 未发布，直接发布当前版本（不新增版本号）。')
    }
  } else if (tagExists) {
    if (bumpType === 'none') {
      action = 'nothing'
      console.log('\n结论：' + currentTag + ' 已发布；新提交只有 docs/test/ci 类，默认不新增版本。')
      console.log('  如需强制发布小版本，请用 --bump patch。')
    } else {
      action = 'bump'
      console.log('\n结论：' + currentTag + ' 已发布，且新提交包含功能/修复变更，建议 ' + bumpType + ' 版本。')
    }
  } else {
    action = forcedBump !== '' ? 'bump' : 'publish-current'
    newTag = currentTag
    console.log('\n结论：' + currentTag + ' 未发布，直接发布当前版本（含自上次标签以来的 ' + commits.length + ' 个提交）。')
  }

  if (action === 'nothing') {
    console.log('\n无需发布。')
    process.exit(0)
  }

  if (dryRun) {
    if (action === 'bump') console.log('[dry-run] 将执行: npm version ' + bumpType + ' → push main → push 新 tag')
    else console.log('[dry-run] 将执行: git push origin main && git push origin ' + newTag)
    process.exit(0)
  }

  // ── 5. execute ───────────────────────────────────────────────────────

  if (action === 'bump') {
    const newVersion = sh('npm version ' + bumpType + ' --no-audit')
    newTag = 'v' + newVersion.replace(/^v/, '')
    console.log('\n已创建版本 ' + newVersion + ' 与标签 ' + newTag + '。')
  } else {
    console.log('\n将发布当前版本 ' + currentTag + '。')
  }

  if (!yes) {
    const readline = require('node:readline').createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise(resolve => readline.question('确认' + (action === 'bump' ? '执行 npm version ' + bumpType : '发布 ' + newTag) + '并推送？[y/N] ', resolve))
    readline.close()
    if (!['y', 'Y'].includes(answer.trim())) {
      console.log('已取消。')
      if (action === 'bump') {
        sh('git tag -d ' + newTag, { allowFail: true })
        sh('git reset --hard HEAD~1', { allowFail: true })
        sh('git checkout -- package.json package-lock.json', { allowFail: true })
      }
      process.exit(0)
    }
  }

  sh('git push origin main')
  console.log('已推送 main。')
  sh('git push origin ' + newTag)
  console.log('已推送标签 ' + newTag + '，GitHub Actions 将自动构建并发布。')
  const repoSlug = sh('git remote get-url origin').replace(/^git@github.com:|https:\/\/github.com\//, '').replace(/\.git$/, '')
  console.log('查看进度：https://github.com/' + repoSlug + '/actions')
}

main().catch(error => {
  console.error('release failed: ' + (error.message || error))
  process.exit(1)
})
