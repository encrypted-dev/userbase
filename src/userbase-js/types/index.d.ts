/* auth */

export interface Session {
  sessionId: string
  creationDate: string
}

export interface UserProfile {
  [key: string]: string
}

export interface UserResult {
  username: string
  key: string
  email?: string
  profile?: UserProfile
}

export type KeyNotFoundHandler = (username: string, deviceId: string) => void

export type ShowKeyHandler = (seedString: string, rememberMe: boolean, backUpKey: boolean) => void | Promise<void>

export function init(options: { appId: string, endpoint?: string, keyNotFoundHandler?: KeyNotFoundHandler }): Promise<Session>

export function signUp(username: string, password: string, email?: string, profile?: UserProfile, showKeyHandler?: ShowKeyHandler, rememberMe?: boolean, backUpKey?: boolean): Promise<UserResult>

export function signIn(username: string, password: string, rememberMe?: boolean): Promise<UserResult>

export function signOut(): Promise<void>

export function forgotPassword(username: string): Promise<void>

export function updateUser(user: { username?: string, password?: string, email?: string | null, profile?: UserProfile | null }): Promise<void>

export function deleteUser(): Promise<void>

export function importKey(keyString: string): Promise<void>

export function getLastUsedUsername(): string | undefined

/* db */

export type DatabaseOperation = InsertOperation | UpdateOperation | DeleteOperation

export interface InsertOperation {
  command: 'Insert'
  id?: string
  item: any
}

export interface UpdateOperation {
  command: 'Update'
  id: string
  item: any
}

export interface DeleteOperation {
  command: 'Delete'
  id: string
}

export function openDatabase(dbName: string, changeHandler: (items: any[]) => void): Promise<void>

export function insertItem(dbName: string, item: any, id?: string): Promise<void>

export function updateItem(dbName: string, item: any, id: string): Promise<void>

export function deleteItem(dbName: string, id: string): Promise<void>

export function transaction(dbName: string, operations: DatabaseOperation[]): Promise<void>