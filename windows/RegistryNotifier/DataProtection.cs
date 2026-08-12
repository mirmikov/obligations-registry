using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace Mirt.RegistryNotifier;

internal static class DataProtection
{
    private const int CryptprotectUiForbidden = 0x1;

    public static string Protect(string value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        var bytes = Encoding.UTF8.GetBytes(value);
        var input = Blob.FromBytes(bytes);
        try
        {
            if (!CryptProtectData(ref input, "RegistryNotifier", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CryptprotectUiForbidden, out var output))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                var encrypted = new byte[output.Size];
                Marshal.Copy(output.Data, encrypted, 0, output.Size);
                return Convert.ToBase64String(encrypted);
            }
            finally
            {
                if (output.Data != IntPtr.Zero) LocalFree(output.Data);
            }
        }
        finally
        {
            input.Free();
        }
    }

    public static string Unprotect(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        var input = Blob.FromBytes(Convert.FromBase64String(value));
        try
        {
            if (!CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CryptprotectUiForbidden, out var output))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                var decrypted = new byte[output.Size];
                Marshal.Copy(output.Data, decrypted, 0, output.Size);
                return Encoding.UTF8.GetString(decrypted);
            }
            finally
            {
                if (output.Data != IntPtr.Zero) LocalFree(output.Data);
            }
        }
        finally
        {
            input.Free();
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Blob
    {
        public int Size;
        public IntPtr Data;

        public static Blob FromBytes(byte[] bytes)
        {
            var blob = new Blob { Size = bytes.Length, Data = Marshal.AllocHGlobal(bytes.Length) };
            Marshal.Copy(bytes, 0, blob.Data, bytes.Length);
            return blob;
        }

        public void Free()
        {
            if (Data == IntPtr.Zero) return;
            Marshal.FreeHGlobal(Data);
            Data = IntPtr.Zero;
        }
    }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(ref Blob dataIn, string? description, IntPtr optionalEntropy, IntPtr reserved, IntPtr promptStruct, int flags, out Blob dataOut);

    [DllImport("crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(ref Blob dataIn, IntPtr description, IntPtr optionalEntropy, IntPtr reserved, IntPtr promptStruct, int flags, out Blob dataOut);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
}
