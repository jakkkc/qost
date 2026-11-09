export interface ParseResult<T> {
  rows: T[];
  errors: string[]; // human-readable problems, one per bad row
}
