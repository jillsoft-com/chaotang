/**
 * Storage 模块入口
 */
export type { StorageBackend, StorageBackendType } from './types'
export { LocalStorageBackend } from './local-storage'
export { IndexedDBBackend } from './indexeddb-storage'
export { FileStorageBackend } from './file-storage'
export { getStorageBackend, setStorageBackend, resetStorageBackend } from './factory'
export { appStorage, initializeAppStorage, flushAppStorage, resetAppStorageForTest } from './app-storage'
export { migrateData, getMigrationStatus, cleanupMigratedData } from './migration'
export type { MigrationStatus } from './migration'
