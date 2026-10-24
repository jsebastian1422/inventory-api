export interface Permission {
  readonly id: string;
  readonly code: string;
  readonly module: string;
  readonly action: string;
  readonly description: string;
}

export interface PermissionRepository {
  listAll(): Promise<Permission[]>;
  /** Returns the codes that do not exist in the catalog. */
  findMissingCodes(codes: readonly string[]): Promise<string[]>;
}
