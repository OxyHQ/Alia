import { Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from '@oxy.so/bloom/table';

interface TableData {
  headers: string[];
  rows: string[][];
}

interface TableRendererProps {
  data: TableData;
  /** Names the table for assistive tech — the canvas component's title. */
  title?: string;
}

/** Below this width per column the table scrolls sideways instead of squeezing. */
const COLUMN_MIN_WIDTH = 100;

export function TableRenderer({ data, title }: TableRendererProps) {
  const { headers, rows } = data;

  return (
    <Table size="sm" accessibilityLabel={title} minWidth={headers.length * COLUMN_MIN_WIDTH}>
      <TableHeader>
        {headers.map((header, i) => (
          <TableColumn key={i} minWidth={COLUMN_MIN_WIDTH}>
            {header}
          </TableColumn>
        ))}
      </TableHeader>
      <TableBody>
        {rows.map((row, rowIdx) => (
          <TableRow key={rowIdx}>
            {row.map((cell, cellIdx) => (
              <TableCell key={cellIdx}>{cell}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
