import { Injectable } from '@angular/core';
import * as XLSX from 'xlsx';

/** Fila del Excel de maletas y relaciones (una fila por producto; maleta repetida). */
export interface ExcelMaletaRow {
  nombreMaleta: string;
  rfidMaestro: string;
  rfidProducto: string;
  referencia: string;
  descripcion: string;
  lote: string;
  caducidad: string;
}

@Injectable({ providedIn: 'root' })
export class ExcelMaletasService {
  /**
   * Genera y descarga un Excel con maletas y sus productos.
   * Una fila por producto; columnas de maleta repetidas en cada fila.
   */
  downloadExcel(rows: ExcelMaletaRow[], filename = 'maletas_relaciones.xlsx'): void {
    const ws = XLSX.utils.json_to_sheet(
      rows.map((r) => ({
        'Nombre Maleta': r.nombreMaleta,
        'RFID Maestro': r.rfidMaestro,
        'RFID Producto': r.rfidProducto,
        'Referencia': r.referencia,
        'Descripción': r.descripcion,
        'Lote': r.lote,
        'Caducidad': r.caducidad,
      }))
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Maletas y productos');
    XLSX.writeFile(wb, filename);
  }

  /**
   * Descarga una plantilla Excel para rellenar y cargar masivamente, con hoja de instrucciones.
   */
  downloadTemplate(filename = 'plantilla_carga_maletas.xlsx'): void {
    const headers = ['Nombre Maleta', 'RFID Maestro', 'RFID Producto', 'Referencia', 'Descripción', 'Lote', 'Caducidad'];
    const exampleRows: ExcelMaletaRow[] = [
      { nombreMaleta: 'Maleta quirúrgica 1', rfidMaestro: 'E28011606000000000000001', rfidProducto: 'E28011606000000000000002', referencia: 'REF-001', descripcion: 'Producto ejemplo', lote: 'L2024', caducidad: '2025-12-31' },
      { nombreMaleta: 'Maleta quirúrgica 1', rfidMaestro: 'E28011606000000000000001', rfidProducto: 'E28011606000000000000003', referencia: 'REF-002', descripcion: 'Otro producto', lote: 'L2024', caducidad: '' },
    ];
    const data = [
      headers,
      ...exampleRows.map((r) => [r.nombreMaleta, r.rfidMaestro, r.rfidProducto, r.referencia, r.descripcion, r.lote, r.caducidad]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);

    const instrucciones = [
      ['INSTRUCCIONES PARA CARGA MASIVA DE MALETAS'],
      [''],
      ['1. Hoja "Maletas y productos"'],
      ['   - La primera fila son los encabezados. No la borre.'],
      ['   - A partir de la fila 2, añada una fila por cada PRODUCTO.'],
      ['   - Cada maleta tiene un Nombre y un RFID Maestro (etiqueta de la maleta).'],
      ['   - Repita el mismo Nombre Maleta y RFID Maestro en todas las filas de esa maleta.'],
      [''],
      ['2. Columnas obligatorias'],
      ['   - Nombre Maleta: nombre identificativo de la maleta.'],
      ['   - RFID Maestro: código RFID de la etiqueta de la maleta.'],
      ['   - RFID Producto: código RFID del producto (puede estar vacío si la maleta no tiene productos).'],
      [''],
      ['3. Columnas opcionales (para cada producto)'],
      ['   - Referencia, Descripción, Lote, Caducidad.'],
      [''],
      ['4. Cómo se importa'],
      ['   - Se agrupa por "Nombre Maleta" + "RFID Maestro".'],
      ['   - Se crea una maleta por cada grupo.'],
      ['   - Se asocian a esa maleta todos los productos (filas con RFID Producto rellenado).'],
      [''],
      ['5. Ejemplo'],
      ['   - Filas 2 y 3 de la plantilla muestran una maleta "Maleta quirúrgica 1" con dos productos.'],
      ['   - Puede borrar las filas de ejemplo y añadir las suyas.'],
    ];
    const wsInst = XLSX.utils.aoa_to_sheet(instrucciones);
    wsInst['!cols'] = [{ wch: 80 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsInst, 'Instrucciones');
    XLSX.utils.book_append_sheet(wb, ws, 'Maletas y productos');
    XLSX.writeFile(wb, filename);
  }

  /**
   * Convierte un valor de caducidad (texto o número serial de Excel) a fecha ISO YYYY-MM-DD para guardar/importar.
   * Si es un número serial de Excel (ej. 46387), lo convierte a fecha; si no, devuelve el texto normalizado.
   */
  static caducidadToIso(val: string | number | null | undefined): string {
    const raw = val === null || val === undefined ? '' : val;
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (Number.isFinite(n) && n >= 1 && n <= 300000) {
      const date = ExcelMaletasService.excelSerialToDate(n);
      return date ? date.toISOString().slice(0, 10) : String(raw).trim();
    }
    return String(raw).trim();
  }

  /**
   * Para mostrar en UI: si el valor es un número serial de Excel, devuelve la fecha en formato YYYY-MM-DD; si no, el valor tal cual.
   */
  static caducidadToDisplay(val: string | number | null | undefined): string {
    const s = val === null || val === undefined ? '' : String(val).trim();
    if (!s) return '–';
    const n = Number(s);
    if (Number.isFinite(n) && n >= 1 && n <= 300000) {
      const date = ExcelMaletasService.excelSerialToDate(n);
      return date ? date.toISOString().slice(0, 10) : s;
    }
    return s;
  }

  /** Convierte número serial de Excel (1 = 1900-01-01) a Date. */
  private static excelSerialToDate(serial: number): Date | null {
    if (!Number.isFinite(serial) || serial < 1) return null;
    const utcMs = (serial - 25569) * 86400 * 1000;
    const d = new Date(utcMs);
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * Devuelve un Date para comparar caducidad (sirve para serial Excel o texto de fecha).
   * Si no se puede interpretar, devuelve null.
   */
  static caducidadToDate(val: string | number | null | undefined): Date | null {
    if (val === null || val === undefined) return null;
    const s = String(val).trim();
    if (!s) return null;
    const n = Number(s);
    if (Number.isFinite(n) && n >= 1 && n <= 300000) {
      return ExcelMaletasService.excelSerialToDate(n);
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * Normaliza un encabezado para comparación (minúsculas, sin acentos, espacios colapsados, trim).
   */
  private static normHeader(h: string): string {
    return String(h ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
  }

  /**
   * Dado un array de encabezados (primera fila), devuelve el índice de la columna que mejor coincide con el nombre esperado.
   */
  private static findColumnIndex(headers: string[], ...candidates: string[]): number {
    const normalizedCandidates = candidates.map((c) => ExcelMaletasService.normHeader(c));
    for (let i = 0; i < headers.length; i++) {
      const n = ExcelMaletasService.normHeader(String(headers[i] ?? ''));
      if (normalizedCandidates.some((c) => n === c || n.includes(c) || c.includes(n))) return i;
    }
    return -1;
  }

  /**
   * Parsea un archivo Excel y devuelve las filas (agrupables por nombreMaleta + rfidMaestro).
   * Prioriza el formato por claves (objeto), que es el que genera nuestra exportación.
   */
  async parseExcelFile(file: File): Promise<ExcelMaletaRow[]> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = e.target?.result;
          if (!data) {
            resolve([]);
            return;
          }
          const wb = XLSX.read(data, { type: 'binary' });
          const sheetName = wb.SheetNames.includes('Maletas y productos')
            ? 'Maletas y productos'
            : wb.SheetNames[0];
          const ws = wb.Sheets[sheetName];

          const rowsByKeys = this.parseWithObjectKeys(ws);
          const hasProductRfid = rowsByKeys.some((r) => r.rfidProducto.trim().length > 0);
          if (hasProductRfid || rowsByKeys.length === 0) {
            resolve(rowsByKeys);
            return;
          }

          const rowsByHeader = this.parseWithHeaderRow(ws);
          resolve(rowsByHeader);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsBinaryString(file);
    });
  }

  /**
   * Parsea usando primera fila como cabeceras e índices de columna.
   */
  private parseWithHeaderRow(ws: XLSX.WorkSheet): ExcelMaletaRow[] {
    const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as (string | number)[][];
    if (rawRows.length < 2) return [];
    const headerRow = (rawRows[0] ?? []).map((c) => String(c ?? ''));
    let idxNombre = ExcelMaletasService.findColumnIndex(headerRow, 'Nombre Maleta', 'nombre maleta', 'nombreMaleta');
    let idxRfidMaestro = ExcelMaletasService.findColumnIndex(headerRow, 'RFID Maestro', 'rfid maestro', 'rfidMaestro');
    let idxRfidProducto = ExcelMaletasService.findColumnIndex(headerRow, 'RFID Producto', 'rfid producto', 'rfidProducto');
    let idxReferencia = ExcelMaletasService.findColumnIndex(headerRow, 'Referencia', 'referencia');
    let idxDescripcion = ExcelMaletasService.findColumnIndex(headerRow, 'Descripción', 'descripcion', 'descripcion');
    let idxLote = ExcelMaletasService.findColumnIndex(headerRow, 'Lote', 'lote');
    let idxCaducidad = ExcelMaletasService.findColumnIndex(headerRow, 'Caducidad', 'caducidad');
    if (idxRfidProducto < 0 && headerRow.length >= 3) idxRfidProducto = 2;
    if (idxNombre < 0 && headerRow.length >= 1) idxNombre = 0;
    if (idxRfidMaestro < 0 && headerRow.length >= 2) idxRfidMaestro = 1;
    if (idxReferencia < 0 && headerRow.length >= 4) idxReferencia = 3;
    if (idxDescripcion < 0 && headerRow.length >= 5) idxDescripcion = 4;
    if (idxLote < 0 && headerRow.length >= 6) idxLote = 5;
    if (idxCaducidad < 0 && headerRow.length >= 7) idxCaducidad = 6;

    const get = (row: (string | number)[], index: number): string =>
      index >= 0 ? String(row[index] ?? '').trim() : '';

    const rows: ExcelMaletaRow[] = [];
    for (let i = 1; i < rawRows.length; i++) {
      const row = rawRows[i] ?? [];
      const rawCaducidad = idxCaducidad >= 0 ? row[idxCaducidad] : '';
      rows.push({
        nombreMaleta: get(row, idxNombre),
        rfidMaestro: get(row, idxRfidMaestro),
        rfidProducto: get(row, idxRfidProducto),
        referencia: get(row, idxReferencia),
        descripcion: get(row, idxDescripcion),
        lote: get(row, idxLote),
        caducidad: ExcelMaletasService.caducidadToIso(rawCaducidad),
      });
    }
    return rows;
  }

  /**
   * Obtiene el valor de un campo buscando la clave que coincida (normalizada).
   */
  private static getByKey(row: Record<string, string | number>, ...keyCandidates: string[]): string {
    const v = ExcelMaletasService.getRawByKey(row, ...keyCandidates);
    return String(v ?? '').trim();
  }

  /** Obtiene el valor en bruto (string o number) para una clave. */
  private static getRawByKey(row: Record<string, string | number>, ...keyCandidates: string[]): string | number {
    const norm = (s: string) => ExcelMaletasService.normHeader(s);
    const targets = keyCandidates.map(norm);
    for (const [key, value] of Object.entries(row)) {
      const n = norm(key);
      if (targets.some((t) => n === t || n.includes(t) || t.includes(n)))
        return value ?? '';
    }
    return '';
  }

  /**
   * Parsea usando sheet_to_json como objetos (claves = primera fila).
   * Busca columnas por nombre normalizado para soportar variaciones.
   */
  private parseWithObjectKeys(ws: XLSX.WorkSheet): ExcelMaletaRow[] {
    const raw = XLSX.utils.sheet_to_json<Record<string, string | number>>(ws, { defval: '' });
    return raw.map((r) => ({
      nombreMaleta: ExcelMaletasService.getByKey(r, 'Nombre Maleta', 'nombreMaleta', 'Nombre maleta'),
      rfidMaestro: ExcelMaletasService.getByKey(r, 'RFID Maestro', 'rfidMaestro', 'RFID maestro'),
      rfidProducto: ExcelMaletasService.getByKey(r, 'RFID Producto', 'rfidProducto', 'RFID producto'),
      referencia: ExcelMaletasService.getByKey(r, 'Referencia', 'referencia'),
      descripcion: ExcelMaletasService.getByKey(r, 'Descripción', 'descripcion'),
      lote: ExcelMaletasService.getByKey(r, 'Lote', 'lote'),
      caducidad: ExcelMaletasService.caducidadToIso(ExcelMaletasService.getRawByKey(r, 'Caducidad', 'caducidad')),
    }));
  }
}
