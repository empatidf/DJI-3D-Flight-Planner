/**
 * File System Access API members that Chromium ships but TypeScript's DOM lib
 * does not declare yet. All optional: other browsers simply lack them.
 */

export {};

declare global {
  type FsaPermissionMode = 'read' | 'readwrite';

  interface FsaPermissionDescriptor {
    mode?: FsaPermissionMode;
  }

  interface FileSystemHandle {
    queryPermission?(descriptor?: FsaPermissionDescriptor): Promise<PermissionState>;
    requestPermission?(descriptor?: FsaPermissionDescriptor): Promise<PermissionState>;
  }

  interface FsaDirectoryPickerOptions {
    /** Lets the browser reopen the picker where this id was last used. */
    id?: string;
    mode?: FsaPermissionMode;
    startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads';
  }

  interface Window {
    showDirectoryPicker?(options?: FsaDirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}
