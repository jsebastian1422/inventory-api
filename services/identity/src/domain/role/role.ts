export interface Role {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly isSystem: boolean;
  /** Permission codes. A system role always has the whole catalog. */
  readonly permissions: string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
