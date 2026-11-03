import Darwin
import Foundation
import SecretCore

/// The ancestors of this process, nearest first (pid, executable path, first arguments), read with libproc and sysctl.
enum ProcessTree {
    static func ancestors() -> [Ancestor] {
        var out: [Ancestor] = []
        var pid = getppid()
        var hops = 0
        while pid > 1, hops < 64 {
            var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
            let path = proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 ? String(cString: buf) : ""
            out.append(Ancestor(pid: pid, path: path, args: args(of: pid)))
            var info = proc_bsdinfo()
            let size = Int32(MemoryLayout<proc_bsdinfo>.size)
            guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { break }
            pid = pid_t(info.pbi_ppid)
            hops += 1
        }
        return out
    }

    /// argv[0] and argv[1] of a process (KERN_PROCARGS2); empty when the kernel does not say.
    static func args(of pid: pid_t) -> [String] {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4 else { return [] }
        var buf = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > 4 else { return [] }
        let argc = buf.withUnsafeBytes { $0.load(as: Int32.self) }
        var i = 4
        while i < size, buf[i] != 0 { i += 1 }   // the executable path
        while i < size, buf[i] == 0 { i += 1 }   // padding
        var args: [String] = []
        while i < size, args.count < min(Int(argc), 2) {
            let start = i
            while i < size, buf[i] != 0 { i += 1 }
            args.append(String(decoding: buf[start..<i], as: UTF8.self))
            i += 1
        }
        return args
    }
}

/// PATH lookup, then realpath(3): the file that would run, with every symlink followed, and its identity.
struct RealResolver: CommandResolver {
    func resolve(_ name: String) -> ResolvedCommand? {
        guard !name.isEmpty, let found = lookup(name), let real = realpath(found, nil) else { return nil }
        defer { free(real) }
        let path = String(cString: real)
        var st = stat()
        guard stat(path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, access(path, X_OK) == 0 else { return nil }
        let fp = "\(st.st_dev):\(st.st_ino):\(st.st_size):\(st.st_mtimespec.tv_sec).\(st.st_mtimespec.tv_nsec):"
            + "\(st.st_ctimespec.tv_sec).\(st.st_ctimespec.tv_nsec):\(st.st_mode):\(st.st_uid)"
        return ResolvedCommand(path: path, fingerprint: fp)
    }

    func fileExists(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue
    }

    private func lookup(_ name: String) -> String? {
        if name.contains("/") { return name }
        for dir in (ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin").split(separator: ":", omittingEmptySubsequences: false) {
            let p = (dir.isEmpty ? "." : String(dir)) + "/" + name
            if fileExists(p), access(p, X_OK) == 0 { return p }
        }
        return nil
    }
}

/// execve of the resolved, approved file in place of this process: the command keeps this pid, so the agent sees only
/// its output. argv[0] stays as typed.
struct ExecveExecutor: CommandExecutor {
    func exec(path: String, argv: [String], extraEnvironment: [String: String]) -> SecretError {
        var env = ProcessInfo.processInfo.environment
        for (k, v) in extraEnvironment { env[k] = v }
        let cArgs = argv.map { strdup($0) } + [nil]
        let cEnv = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        fflush(stdout); fflush(stderr)
        execve(path, cArgs, cEnv)
        let why = String(cString: strerror(errno))
        cArgs.forEach { free($0) }
        cEnv.forEach { free($0) }
        return .execFailed("\(path): \(why)")
    }
}
