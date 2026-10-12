using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("AI Buddy")]
[assembly: AssemblyProduct("AI Buddy")]
[assembly: AssemblyDescription("AI Buddy portable launcher")]

internal static class PortableLauncher {
    private static string Under(string root, string value) {
        string full = Path.GetFullPath(Path.Combine(root, value));
        if (!full.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("A package path points outside the AI Buddy folder.");
        return full;
    }
    // Windows CommandLineToArgvW quoting, including paths ending in a backslash.
    private static string Quote(string value) {
        var result = new StringBuilder("\""); int slash = 0;
        foreach (char c in value) {
            if (c == '\\') { slash++; continue; }
            if (c == '"') result.Append('\\', slash * 2 + 1);
            else result.Append('\\', slash);
            result.Append(c); slash = 0;
        }
        return result.Append('\\', slash * 2).Append('"').ToString();
    }
    [STAThread]
    private static int Main(string[] args) {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        try {
            // Also works when placed next to the extracted AI-Buddy folder.
            if (!File.Exists(Path.Combine(root, "local", "current-build.json")) &&
                File.Exists(Path.Combine(root, "AI-Buddy", "local", "current-build.json"))) root = Path.Combine(root, "AI-Buddy");
            var pointer = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(root, "local", "current-build.json"), Encoding.UTF8));
            string build = Under(root, (string)pointer["path"]);
            if (!File.Exists(Path.Combine(build, "main.cjs"))) throw new FileNotFoundException("The application build is missing. Extract the complete ZIP first.");
            var runtime = (Dictionary<string, object>)pointer["runtime"];
            string runtimeFolder = Under(root, (string)runtime["path"]);
            if (!runtimeFolder.StartsWith(Path.Combine(root, "runtime") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Invalid runtime path.");
            string exeName = (string)runtime["executable"];
            if (exeName != Path.GetFileName(exeName)) throw new InvalidDataException("Invalid executable name.");
            string exe = Under(runtimeFolder, exeName);
            if (!File.Exists(exe)) throw new FileNotFoundException("AI Buddy runtime is missing. Extract the complete ZIP first.", exe);
            using (var sha = SHA256.Create()) using (var stream = File.OpenRead(exe)) {
                string actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                if (!String.Equals(actual, (string)runtime["sha256"], StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Runtime integrity check failed. Please extract a fresh copy of the ZIP.");
            }
            var command = new StringBuilder(Quote(build)).Append(" --open=overview");
            foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            var info = new ProcessStartInfo(exe, command.ToString()) { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true };
            using (var child = Process.Start(info)) {
                if (child == null) throw new InvalidOperationException("Windows did not start AI Buddy.");
            }
            return 0;
        } catch (Exception error) {
            string details = error.ToString(), log = Path.Combine(Path.GetTempPath(), "AI-Buddy-launch-error.txt");
            try { File.WriteAllText(log, DateTime.Now.ToString("s") + Environment.NewLine + root + Environment.NewLine + details, Encoding.UTF8); } catch { }
            MessageBox.Show("AI Buddy could not start.\n\n" + error.Message + "\n\nDetails: " + log, "AI Buddy", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
