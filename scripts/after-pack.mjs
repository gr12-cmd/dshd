/**
 * electron-builder afterPack 钩子：把项目的 node_modules 完整复制进打包产物。
 *
 * electron-builder 自带的依赖收集在 pnpm 布局下会漏掉大量传递依赖
 * （只有 9/195 个 @deepseek-ai 包进入产物），导致 dsh 引擎无法启动。
 * 这里直接整体复制扁平化的 node_modules，保证依赖闭包完整。
 *
 * 平台原生模块补全（031）：koffi 等用 optionalDependencies 分发平台二进制
 * （@koromix/koffi-<platform>-<arch>）。本机 macOS 打包 win 时，darwin 平台包
 * 会被复制但 win 平台包缺失 → Windows 上原生模块加载失败 → dsh 引擎起不来。
 * 这里在打包前把目标平台的原生模块包补进 src，保证跨平台打包不缺二进制。
 */
import { cpSync, existsSync, readdirSync, rmSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

/** 目标平台 → 需要的 koffi 平台包名（031：win 交叉打包必补）。 */
function koffiPlatformPackage(targetPlatform) {
  const map = {
    win32: 'koffi-win32-x64', // 打包目标是 x64
    linux: 'koffi-linux-x64',
    darwin: process.arch === 'arm64' ? 'koffi-darwin-arm64' : 'koffi-darwin-x64',
  }
  return map[targetPlatform] ?? null
}

/** koffi 原生二进制的预期路径（koffi 主包 loadDynamic 按 platform_abi/koffi.node 查找）。 */
function koffiNativeBinary(pkgDir, targetPlatform) {
  // koffi 平台包内布局：linux_x64/koffi.node、musl_x64/koffi.node、win32_x64/koffi.node …
  // 包名已含 arch（koffiPlatformPackage 固定 x64），故 abi 与包名一致。
  // 仅检查目录存在不够（可能空壳/断链），必须确认 .node 二进制真实在位。
  const abi = targetPlatform === 'darwin' && process.arch === 'arm64' ? 'arm64' : 'x64'
  return join(pkgDir, `${targetPlatform}_${abi}`, 'koffi.node')
}

/** 确保某平台原生模块包存在于 src（不存在则从 npm 拉取到 node_modules）。 */
function ensurePlatformNativeModules(projectRoot, targetPlatform, src) {
  const scoped = '@koromix'
  const pkgName = koffiPlatformPackage(targetPlatform)
  if (!pkgName) return
  const scopedDir = join(src, scoped)
  const pkgDir = join(scopedDir, pkgName)
  // 只检查目录存在不够：pnpm 在某些布局下可能留下空壳或符号链接断链。
  // 必须确认 .node 二进制真实在位，否则 koffi 加载时仍会崩。
  const nativeBin = koffiNativeBinary(pkgDir, targetPlatform)
  if (existsSync(nativeBin)) {
    console.log(`[afterPack] 平台原生模块已存在: ${scoped}/${pkgName}（${nativeBin.slice(src.length)}）`)
    return
  }
  console.log(`[afterPack] 补平台原生模块: ${scoped}/${pkgName} (target=${targetPlatform})`)
  // koffi 是 dsh-subprocess-local 的硬依赖（顶层 import，无平台门控），缺失会让
  // 引擎启动时崩溃——没有静默降级的余地。这里失败必须抛错，让 CI 在打包步骤就
  // 明确失败并打印原因，而不是事后由 verify-deb 告警。
  // 用 npm pack 拉 tarball → 手动解包进 node_modules（不写 package.json）
  // stdio: 'inherit' 让 npm/tar 的输出进 CI 日志，便于排查网络或 registry 问题
  execFileSync('npm', ['pack', `${scoped}/${pkgName}`, '--pack-destination', projectRoot], {
    cwd: projectRoot,
    stdio: 'inherit',
    timeout: 120_000,
  })
  // npm pack 输出 koromix-koffi-win32-x64-<ver>.tgz（去掉 @ 前缀），用 glob 找实际文件
  const tgzFile = readdirSync(projectRoot).find((f) => f.includes(pkgName) && f.endsWith('.tgz'))
  if (!tgzFile) throw new Error('npm pack 未生成 tarball')
  const tgz = join(projectRoot, tgzFile)
  // tarball 结构是 package/...，先解到临时目录再把 package 移到目标位置
  const tmpDir = join(projectRoot, `.tmp-${pkgName}`)
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  execFileSync('tar', ['-xzf', tgz, '-C', tmpDir], { cwd: projectRoot, stdio: 'inherit' })
  const unpacked = join(tmpDir, 'package')
  if (!existsSync(unpacked)) throw new Error('tarball 无 package/ 目录')
  mkdirSync(scopedDir, { recursive: true })
  rmSync(pkgDir, { recursive: true, force: true })
  cpSync(unpacked, pkgDir, { recursive: true })
  rmSync(tmpDir, { recursive: true, force: true })
  rmSync(tgz, { force: true })
  if (!existsSync(nativeBin)) {
    throw new Error(`补全后 ${scoped}/${pkgName} 仍缺 .node 二进制（${nativeBin}）——检查 npm pack 拉到的 tarball 是否匹配平台`)
  }
  console.log(`[afterPack] ✅ ${scoped}/${pkgName} 已补全`)
}

/**
 * 复制时排除的顶层包名（devDependencies + 明确的构建工具/运行时重复物）。
 * dsh 引擎需要完整运行时依赖闭包，但 dev 依赖（electron 运行时、builder、TS 等）
 * 不该进产物——这是体积大头（约 500MB 中的 300MB+）。
 */
function loadDevDeps(projectRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
    return new Set(Object.keys(pkg.devDependencies ?? {}))
  } catch {
    return new Set()
  }
}

/** electron-builder Arch 枚举 → 字符串（context.arch 是 Arch 枚举值）。
 *  注意 Arch 的真实数值：ia32=0 x64=1 armv7l=2 arm64=3 universal=4
 *  （builder-util/out/arch.d.ts）。 */
function archName(arch) {
  const map = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }
  return map[arch] ?? 'x64'
}

/**
 * 判断包名是否为「非目标平台/架构」的原生 prebuild（PR #304 实践）。
 * sharp / koffi / esbuild / ripgrep 等用 optionalDependencies 分发各平台二进制，
 * 它们会同时落进扁平 node_modules；x64-only 产物里 arm64/win32/darwin 的 prebuild
 * 全是死重量（数十 MB）。按包名末尾的 -<platform>-<arch> 标记排除非目标者。
 *
 * 特殊处理：当目标是 armv7l 时，允许 x64 二进制（CI 环境通常是 x64，交叉编译 armv7l 时
 * npm registry 里的 prebuild 也是 x64，不能排除）。
 */
function isNonTargetPrebuild(pkgName, targetPlatform, targetArch) {
  const m = pkgName.match(/-(linux|win32|darwin|freebsd|sunos)-(x64|arm64|arm32|ia32|armv7l)$/)
  if (!m) return false
  const [, plat, arch] = m
  
  // 平台必须匹配
  if (plat !== targetPlatform) return true
  
  // 特殊情况：当目标架构是 armv7l 时，允许 x64 二进制
  // （原因：CI 通常运行在 x64，交叉编译 armv7l 产物时，npm registry 的 prebuild 也是 x64，
  //  这些二进制用于构建工具链或跨平台打包，不会在最终产物运行时加载）
  if (targetArch === 'armv7l' && arch === 'x64') return false
  
  // 否则架构必须完全匹配
  return arch !== targetArch
}

/** 是否应排除某顶层包：dev 依赖、构建工具，或非目标平台的 prebuild。 */
function shouldExclude(name, devDeps, targetPlatform, targetArch) {
  if (devDeps.has(name)) return true
  // 构建/打包工具链（即使非 devDep 也排除，运行时不加载）
  const buildTools = new Set(['app-builder-bin', '7zip-bin', 'esbuild', 'electron-builder-binaries'])
  if (buildTools.has(name)) return true
  return isNonTargetPrebuild(name, targetPlatform, targetArch)
}

export default async function afterPack(context) {
  const { appOutDir, packager } = context
  const projectRoot = packager.projectDir
  const src = join(projectRoot, 'node_modules')

  if (!existsSync(src)) {
    console.warn('[afterPack] node_modules 不存在，跳过复制')
    return
  }

  const devDeps = loadDevDeps(projectRoot)
  // 目标平台/架构：用于排除非目标平台的 prebuild（context.arch 为数字枚举）
  const targetPlatform = context.electronPlatformName ?? packager.platform.nodeName
  const targetArch = archName(context.arch)
  console.log(`[afterPack] 目标平台: ${targetPlatform}/${targetArch}`)

  // 031：交叉打包时补目标平台原生模块（koffi 等）——必须在 cpSync 之前
  ensurePlatformNativeModules(projectRoot, packager.platform.nodeName, src)

  // appOutDir 可能是 .app 目录本身，也可能是包含 .app 的父目录（mac）
  let appBundle = appOutDir
  if (!existsSync(join(appBundle, 'Contents', 'Info.plist'))) {
    const app = readdirSync(appOutDir).find((name) => name.endsWith('.app'))
    if (app) appBundle = join(appOutDir, app)
  }
  // mac 布局：Contents/Resources/app/node_modules；win/linux：resources/app/node_modules
  const appResources = existsSync(join(appBundle, 'Contents', 'Resources'))
    ? join(appBundle, 'Contents', 'Resources')
    : join(appBundle, 'resources')
  const dest = join(appResources, 'app', 'node_modules')

  console.log(`[afterPack] 复制 node_modules → ${dest}（排除 devDependencies 与构建工具）`)
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      if (p.includes('/.git/')) return false
      // 只对"包根"做排除判断：node_modules/<name> 或 node_modules/<scope>/<name>
      const rel = p.slice(src.length + 1)
      const seg = rel.split('/')
      // 包名 = 首层（非 scope）或 "@scope/name"（scope 包用完整名匹配 devDeps）
      let pkgName = null
      if (seg.length >= 1 && !seg[0].startsWith('@')) pkgName = seg[0]
      else if (seg.length >= 2 && seg[0].startsWith('@')) pkgName = `${seg[0]}/${seg[1]}`
      if (pkgName !== null) {
        // 只判断包根路径（后面是包内文件）
        const isRoot = !seg[0].startsWith('@') ? seg.length === 1 : seg.length === 2
        if (isRoot) return !shouldExclude(pkgName, devDeps, targetPlatform, targetArch)
      }
      return true
    },
  })
  try {
    const count = readdirSync(join(dest, '@deepseek-ai')).length
    console.log(`[afterPack] 复制完成，@deepseek-ai 包数 = ${count}`)
  } catch {
    console.log('[afterPack] 复制完成（无 @deepseek-ai 目录）')
  }

  // 最终断言：koffi 原生二进制必须进了产物。koffi 是 dsh-subprocess-local 的硬依赖
  // （顶层 import 无平台门控），缺失即引擎启动崩溃。这里区分两种根因便于排查：
  //   - 源里就没有 → ensurePlatformNativeModules 未补上（见上面的日志）
  //   - 源里有但没复制 → filter 误排除（不应发生，isNonTargetPrebuild 保留 linux-x64）
  const koffiPkg = koffiPlatformPackage(packager.platform.nodeName)
  if (koffiPkg) {
    const destBin = koffiNativeBinary(join(dest, '@koromix', koffiPkg), packager.platform.nodeName)
    if (!existsSync(destBin)) {
      const srcBin = koffiNativeBinary(join(src, '@koromix', koffiPkg), packager.platform.nodeName)
      const inSrc = existsSync(srcBin)
      throw new Error(
        `[afterPack] 产物缺 koffi 原生二进制: ${destBin}\n` +
        `  源 node_modules ${inSrc ? '有' : '无'} 该二进制（${srcBin}）。\n` +
        (inSrc
          ? '  源有但没复制 → 检查 cpSync filter 的 shouldExclude 是否误排了 @koromix/' + koffiPkg
          : '  源也没有 → ensurePlatformNativeModules 的 npm pack 兜底失败，见上方日志')
      )
    }
    console.log(`[afterPack] ✅ koffi 原生二进制已在产物: ${destBin.slice(dest.indexOf('node_modules'))}`)
  }
}
