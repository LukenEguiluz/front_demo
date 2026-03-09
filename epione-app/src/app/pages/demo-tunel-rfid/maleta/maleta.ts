import { ChangeDetectorRef, Component, NgZone, OnInit, OnDestroy } from '@angular/core';
import { CommonModule, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RfidApi, Reader, Antenna, ReaderStatus } from '../../../services/rfid-api';
import { MaletasApi, MaletaBackend, ProductoBackend } from '../../../services/maletas-api';
import { ExcelMaletasService, ExcelMaletaRow } from '../../../services/excel-maletas';
import { forkJoin, from, of } from 'rxjs';
import { concatMap, switchMap, tap, toArray } from 'rxjs/operators';

interface TagCount {
  id: string;
  count: number;
  lastSeen: string;
}

/** Producto dentro de una maleta (para formulario nueva maleta). */
export interface NewProductoItem {
  rfid: string;
  referencia: string;
  descripcion: string;
  lote: string;
  caducidad: string;
}

/** Maleta: nombre, RFID maestro (la maleta) + RFIDs/productos dentro. */
export interface MaletaItem {
  id: string;
  nombre?: string;
  masterRfid: string;
  productRfids: string[];
  /** Datos de productos (referencia, descripción, lote, caducidad) cuando vienen del backend. */
  productos?: ProductoBackend[];
  createdAt: string;
  /** RFIDs de productos marcados como caducados (semáforo rojo por producto). */
  expiredProductRfids?: string[];
}

export type SemaphoreStatus = 'red' | 'blue' | 'yellow' | 'green';

@Component({
  selector: 'app-maleta',
  imports: [CommonModule, FormsModule, JsonPipe],
  templateUrl: './maleta.html',
  styleUrl: './maleta.css',
})
export class Maleta implements OnInit, OnDestroy {
  apiBaseUrl = '';
  readers: Reader[] = [];
  antennas: Antenna[] = [];
  selectedReaderId = '';
  readerStatus: ReaderStatus | null = null;
  loading = false;
  error = '';
  statusPolling: ReturnType<typeof setInterval> | null = null;
  uiRefreshInterval: ReturnType<typeof setInterval> | null = null;
  /** Polling de GET /api/readers/:id/tags para actualizar tagCounts si el gateway no usa SSE/WS. */
  tagsPollingInterval: ReturnType<typeof setInterval> | null = null;

  events: Array<{ time: string; data: unknown }> = [];
  maxEvents = 200;
  sseConnected = false;
  eventSource: EventSource | null = null;
  ws: WebSocket | null = null;
  eventsReceived = 0;

  tagCounts = new Map<string, TagCount>();
  totalReads = 0;

  /** Reintento cada 15 s cuando no hay lectores; cuenta atrás visible (s). */
  readonly retryIntervalSeconds = 15;
  retryCountdown = 0;
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  /** Lista de maletas guardadas (RFID maestro + productos). */
  maletas: MaletaItem[] = [];
  private static readonly MALETAS_STORAGE_KEY = 'maleta_list';

  /** Formulario nueva maleta */
  showCreateMaleta = false;
  newMaletaNombre = '';
  newMaletaMasterRfid = '';
  /** Productos a añadir (RFID + referencia, descripción, lote, caducidad). */
  newMaletaProductos: NewProductoItem[] = [];
  newProductRfidInput = '';
  newProductReferencia = '';
  newProductDescripcion = '';
  newProductLote = '';
  newProductCaducidad = '';

  /** URL del API de maletas (backend). Si está definida, se usa el backend. */
  maletasApiUrl = '';
  useBackend = false;

  excelLoading = false;
  excelError = '';

  /** Simular lectura del túnel: texto con etiquetas (una por línea o separadas por coma). */
  simulatedReadInput = '';

  /** Si false, se usa la lectura real del túnel (tagCounts) en lugar del texto simulado. */
  showSimulatedRead = true;
  private static readonly SHOW_SIMULATED_KEY = 'maleta_show_simulated';

  constructor(
    public api: RfidApi,
    public maletasApi: MaletasApi,
    private excelMaletas: ExcelMaletasService,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef
  ) {}

  get isReading(): boolean {
    return !!this.readerStatus?.reading;
  }

  get uniqueCount(): number {
    return this.tagCounts.size;
  }

  get tagList(): TagCount[] {
    return Array.from(this.tagCounts.values()).sort((a, b) => b.count - a.count);
  }

  /** Etiquetas leídas en la simulación (líneas o separadas por coma). */
  get simulatedReadTags(): string[] {
    const raw = (this.simulatedReadInput || '').trim();
    if (!raw) return [];
    return raw
      .split(/[\r\n,;]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /** Etiquetas consideradas como "leídas": simulación o lectura real del túnel según showSimulatedRead. */
  get effectiveReadTags(): string[] {
    if (this.showSimulatedRead) return this.simulatedReadTags;
    return Array.from(this.tagCounts.keys());
  }

  /** Conjunto de todos los RFIDs cargados en las maletas (maestros + productos). */
  private getExpectedTagUnion(): Set<string> {
    const set = new Set<string>();
    for (const m of this.maletas) {
      set.add((m.masterRfid || '').trim());
      for (const r of m.productRfids || []) {
        set.add((r || '').trim());
      }
    }
    set.delete('');
    return set;
  }

  /** True si se leyó al menos una etiqueta que no está cargada en ninguna maleta. */
  get hasUnknownTagRead(): boolean {
    if (this.maletas.length === 0) return false;
    const expected = this.getExpectedTagUnion();
    const read = this.effectiveReadTags;
    return read.some((r) => r.length > 0 && !expected.has(r));
  }

  /** Lista única de etiquetas leídas que no están en ninguna maleta (productos extras no enlistados). */
  get extraUnlistedTags(): string[] {
    if (this.maletas.length === 0) return [];
    const expected = this.getExpectedTagUnion();
    const read = this.effectiveReadTags;
    const unlisted = new Set<string>();
    for (const r of read) {
      if (r.length > 0 && !expected.has(r)) unlisted.add(r);
    }
    return Array.from(unlisted);
  }

  /** Estado del semáforo por maleta: rojo=algún producto caducado por fecha, azul=incompleta, verde=completa. */
  getMaletaStatus(m: MaletaItem): SemaphoreStatus {
    const hasExpired = (m.productRfids || []).some((rfid) => this.isProductExpired(m, rfid));
    if (hasExpired) return 'red';
    const expected = [m.masterRfid, ...m.productRfids].map((s) => s.trim()).filter((s) => s.length > 0);
    const read = this.effectiveReadTags;
    const missing = expected.filter((e) => !read.includes(e));
    if (missing.length > 0) return 'blue';
    return 'green'; /* maleta completada: todos sus RFIDs leídos */
  }

  /** Progreso de lectura de la maleta: cuántos esperados ya se leyeron. */
  getMaletaProgress(m: MaletaItem): { read: number; total: number } {
    const expected = [m.masterRfid, ...m.productRfids].map((s) => s.trim());
    const read = this.effectiveReadTags;
    const readCount = expected.filter((e) => read.includes(e)).length;
    return { read: readCount, total: expected.length };
  }

  /** Resumen de lectura: si la etiqueta de la maleta se leyó y cuántos productos se leyeron. */
  getMaletaReadSummary(m: MaletaItem): { masterRead: boolean; productsRead: number; productsTotal: number } {
    const read = this.effectiveReadTags;
    const masterRead = read.includes((m.masterRfid || '').trim());
    const productsTotal = (m.productRfids || []).length;
    const productsRead = (m.productRfids || []).filter((rfid) => read.includes((rfid || '').trim())).length;
    return { masterRead, productsRead, productsTotal };
  }

  /** Formato de caducidad para mostrar (convierte serial Excel a fecha legible). */
  formatCaducidad(val: string | null | undefined): string {
    return ExcelMaletasService.caducidadToDisplay(val);
  }

  /** True si la fecha de caducidad ya pasó (según fecha del sistema). Acepta texto de fecha o número serial de Excel. */
  private isDateExpired(caducidad: string | null | undefined): boolean {
    const date = ExcelMaletasService.caducidadToDate(caducidad);
    if (!date) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d.getTime() <= today.getTime();
  }

  /** Indica si un producto está caducado según su campo caducidad y la fecha del sistema. */
  isProductExpired(m: MaletaItem, rfid: string): boolean {
    const p = this.getProductoInfo(m, rfid);
    return p ? this.isDateExpired(p.caducidad) : false;
  }

  /** RFIDs que faltan por leer para esta maleta (solo si estado azul). */
  getMaletaMissing(m: MaletaItem): string[] {
    const expected = [m.masterRfid, ...m.productRfids].map((s) => s.trim());
    const read = this.effectiveReadTags;
    return expected.filter((e) => !read.includes(e));
  }

  /** Indica si un RFID ya está en la lectura (simulada o real). */
  isTagRead(rfid: string): boolean {
    const id = (rfid || '').trim();
    return id.length > 0 && this.effectiveReadTags.includes(id);
  }

  toggleShowSimulatedRead(): void {
    this.showSimulatedRead = !this.showSimulatedRead;
    try {
      localStorage.setItem(Maleta.SHOW_SIMULATED_KEY, String(this.showSimulatedRead));
    } catch {}
  }

  /** Número de maletas completadas (semáforo verde). */
  get completedMaletasCount(): number {
    return this.maletas.filter((m) => this.getMaletaStatus(m) === 'green').length;
  }

  /** Semáforo general: rojo si alguna maleta tiene caducado; amarillo si hay producto extra no enlistado; azul/verde según maletas. */
  get generalSemaphoreStatus(): SemaphoreStatus {
    if (this.maletas.length === 0) return 'green';
    const statuses = this.maletas.map((m) => this.getMaletaStatus(m));
    if (statuses.some((s) => s === 'red')) return 'red';
    if (this.hasUnknownTagRead) return 'yellow';
    if (statuses.some((s) => s === 'yellow')) return 'yellow';
    if (statuses.some((s) => s === 'blue')) return 'blue';
    return 'green';
  }


  semaphoreTitle(status: SemaphoreStatus): string {
    switch (status) {
      case 'red': return 'Caducada';
      case 'blue': return 'Incompleta (leyendo o faltan RFID)';
      case 'yellow': return 'Lectura con etiquetas extra';
      case 'green': return 'Lectura completa';
      default: return '';
    }
  }

  semaphoreLegend(status: SemaphoreStatus): string {
    switch (status) {
      case 'red': return 'Caducada';
      case 'blue': return 'Incompleta';
      case 'yellow': return 'Extra';
      case 'green': return 'Completa';
      default: return '';
    }
  }

  /** URL por defecto para la vista Maleta (túnel). */
  private static readonly MALETA_API = 'https://rfid.leyluz.com';

  /** True si no hay lectores (muestra timer de reintento). */
  get needsRetry(): boolean {
    return !this.loading && this.api.getBaseUrl() !== '' && this.readers.length === 0;
  }

  ngOnInit(): void {
    this.api.setBaseUrl(Maleta.MALETA_API);
    this.apiBaseUrl = this.api.getBaseUrl();
    this.maletasApiUrl = this.maletasApi.getBaseUrl();
    this.useBackend = !!this.maletasApiUrl;
    this.retryCountdown = this.retryIntervalSeconds;
    try {
      const saved = localStorage.getItem(Maleta.SHOW_SIMULATED_KEY);
      if (saved !== null) this.showSimulatedRead = saved === 'true';
    } catch {}
    if (this.useBackend) this.loadMaletasFromApi();
    else this.loadMaletasFromStorage();
    this.loadReaders();
    this.loadAntennas();
    this.startRetryTimer();
  }

  private loadMaletasFromStorage(): void {
    try {
      const raw = localStorage.getItem(Maleta.MALETAS_STORAGE_KEY);
      if (raw) {
        this.maletas = JSON.parse(raw);
        this.maletas.forEach((m) => {
          if ((m as { expired?: boolean }).expired && m.productRfids?.length) {
            m.expiredProductRfids = [...m.productRfids];
            delete (m as { expired?: boolean }).expired;
          }
        });
      }
    } catch {
      this.maletas = [];
    }
  }

  private loadMaletasFromApi(): void {
    this.maletasApi.getMaletas().subscribe((list) => {
      if (list.length === 0) {
        this.maletas = [];
        this.cdr.detectChanges();
        return;
      }
      forkJoin(list.map((m) => this.maletasApi.getMaleta(m.id))).subscribe((fullList) => {
        this.maletas = fullList
          .map((full): MaletaItem | null => {
            if (!full) return null;
            const productRfids = full.productRfids?.length ? full.productRfids : (full.productos?.map((p) => p.rfid) ?? []);
            return {
              id: full.id,
              nombre: full.nombre,
              masterRfid: full.masterRfid || '',
              productRfids,
              productos: full.productos,
              createdAt: full.createdAt,
            } as MaletaItem;
          })
          .filter((m): m is MaletaItem => m !== null);
        this.cdr.detectChanges();
      });
    });
  }

  private saveMaletasToStorage(): void {
    try {
      localStorage.setItem(Maleta.MALETAS_STORAGE_KEY, JSON.stringify(this.maletas));
    } catch {}
  }

  openCreateMaleta(): void {
    this.showCreateMaleta = true;
    this.newMaletaNombre = '';
    this.newMaletaMasterRfid = '';
    this.newMaletaProductos = [];
    this.newProductRfidInput = '';
    this.newProductReferencia = '';
    this.newProductDescripcion = '';
    this.newProductLote = '';
    this.newProductCaducidad = '';
  }

  closeCreateMaleta(): void {
    this.showCreateMaleta = false;
  }

  /** Usar un tag de la lectura como RFID maestro. */
  setMasterFromTag(tagId: string): void {
    this.newMaletaMasterRfid = tagId.trim();
  }

  /** Añadir un tag de la lectura como producto (evita duplicar y que sea el maestro). */
  addProductFromTag(tagId: string): void {
    const id = tagId.trim();
    if (!id || id === this.newMaletaMasterRfid) return;
    if (this.newMaletaProductos.some((p) => p.rfid === id)) return;
    this.newMaletaProductos = [...this.newMaletaProductos, { rfid: id, referencia: '', descripcion: '', lote: '', caducidad: '' }];
  }

  addProductManual(): void {
    const id = this.newProductRfidInput.trim();
    if (!id) return;
    if (this.newMaletaProductos.some((p) => p.rfid === id)) {
      this.newProductRfidInput = '';
      return;
    }
    this.newMaletaProductos = [
      ...this.newMaletaProductos,
      {
        rfid: id,
        referencia: this.newProductReferencia,
        descripcion: this.newProductDescripcion,
        lote: this.newProductLote,
        caducidad: this.newProductCaducidad,
      },
    ];
    this.newProductRfidInput = '';
    this.newProductReferencia = '';
    this.newProductDescripcion = '';
    this.newProductLote = '';
    this.newProductCaducidad = '';
  }

  removeProduct(rfid: string): void {
    this.newMaletaProductos = this.newMaletaProductos.filter((p) => p.rfid !== rfid);
  }

  /** Indica si un RFID ya está en la lista de productos de la nueva maleta (para deshabilitar el botón). */
  isProductInNewMaleta(rfid: string): boolean {
    return this.newMaletaProductos.some((p) => p.rfid === rfid);
  }

  saveMaleta(): void {
    const master = this.newMaletaMasterRfid.trim();
    if (!master) return;
    if (this.useBackend) {
      this.maletasApi
        .createMaleta({
          nombre: this.newMaletaNombre.trim() || 'Sin nombre',
          masterRfid: master,
        })
        .subscribe((created) => {
          if (!created) {
            this.cdr.detectChanges();
            return;
          }
          let pending = this.newMaletaProductos.length;
          if (pending === 0) {
            this.loadMaletasFromApi();
            this.closeCreateMaleta();
            this.cdr.detectChanges();
            return;
          }
          this.newMaletaProductos.forEach((p) => {
            this.maletasApi
              .crearProductoEnMaleta(created.id, {
                rfid: p.rfid,
                referencia: p.referencia || undefined,
                descripcion: p.descripcion || undefined,
                lote: p.lote || undefined,
                caducidad: p.caducidad || undefined,
              })
              .subscribe(() => {
                pending--;
                if (pending === 0) {
                  this.loadMaletasFromApi();
                  this.closeCreateMaleta();
                  this.cdr.detectChanges();
                }
              });
          });
        });
      return;
    }
    const item: MaletaItem = {
      id: `maleta_${Date.now()}`,
      nombre: this.newMaletaNombre.trim() || undefined,
      masterRfid: master,
      productRfids: this.newMaletaProductos.map((p) => p.rfid),
      createdAt: new Date().toISOString(),
    };
    this.maletas = [item, ...this.maletas];
    this.saveMaletasToStorage();
    this.closeCreateMaleta();
    this.cdr.detectChanges();
  }

  deleteMaleta(item: MaletaItem, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (this.useBackend) {
      this.maletasApi.deleteMaleta(item.id).subscribe((ok) => {
        if (ok) this.loadMaletasFromApi();
        this.cdr.detectChanges();
      });
      return;
    }
    this.maletas = this.maletas.filter((m) => m.id !== item.id);
    this.saveMaletasToStorage();
  }

  saveMaletasApiUrl(): void {
    this.maletasApi.setBaseUrl(this.maletasApiUrl);
    this.useBackend = !!this.maletasApi.getBaseUrl();
    if (this.useBackend) this.loadMaletasFromApi();
    this.cdr.detectChanges();
  }

  /** Al abrir una maleta, cargar productos con detalle (referencia, lote, caducidad) si usamos backend. */
  onMaletaToggle(m: MaletaItem, event: Event): void {
    const details = event.target as HTMLDetailsElement;
    if (!details?.open || !this.useBackend || m.productos) return;
    this.maletasApi.getMaleta(m.id).subscribe((full) => {
      if (full?.productos) {
        m.productos = full.productos;
        this.cdr.detectChanges();
      }
    });
  }

  /** Datos de un producto por RFID dentro de una maleta (para mostrar ref, lote, caducidad). */
  getProductoInfo(m: MaletaItem, rfid: string): ProductoBackend | undefined {
    return m.productos?.find((p) => p.rfid === rfid);
  }

  /** Descarga maletas y relaciones en Excel (desde backend o desde lista local). */
  exportToExcel(): void {
    this.excelError = '';
    this.excelLoading = true;
    this.cdr.detectChanges();
    if (!this.useBackend) {
      const rows: ExcelMaletaRow[] = [];
      this.maletas.forEach((m) => {
        const nombre = m.nombre || '';
        const master = m.masterRfid || '';
        (m.productRfids || []).forEach((rfid) => {
          const p = m.productos?.find((x) => x.rfid === rfid);
          rows.push({
            nombreMaleta: nombre,
            rfidMaestro: master,
            rfidProducto: rfid,
            referencia: p?.referencia || '',
            descripcion: p?.descripcion || '',
            lote: p?.lote || '',
            caducidad: p?.caducidad || '',
          });
        });
        if ((m.productRfids || []).length === 0) {
          rows.push({ nombreMaleta: nombre, rfidMaestro: master, rfidProducto: '', referencia: '', descripcion: '', lote: '', caducidad: '' });
        }
      });
      this.excelMaletas.downloadExcel(rows, `maletas_relaciones_${new Date().toISOString().slice(0, 10)}.xlsx`);
      this.excelLoading = false;
      this.cdr.detectChanges();
      return;
    }
    this.maletasApi
      .getMaletas()
      .pipe(
        switchMap((list) => {
          if (list.length === 0) {
            this.excelMaletas.downloadExcel([], 'maletas_relaciones.xlsx');
            return of(undefined);
          }
          return forkJoin(list.map((m) => this.maletasApi.getMaleta(m.id))).pipe(
            tap((fullMaletas) => {
              const rows: ExcelMaletaRow[] = [];
              fullMaletas.forEach((full) => {
                if (!full) return;
                const nombre = full.nombre || '';
                const master = full.masterRfid || '';
                const productos = full.productos || [];
                if (productos.length === 0) {
                  rows.push({ nombreMaleta: nombre, rfidMaestro: master, rfidProducto: '', referencia: '', descripcion: '', lote: '', caducidad: '' });
                } else {
                  productos.forEach((p) => {
                    rows.push({
                      nombreMaleta: nombre,
                      rfidMaestro: master,
                      rfidProducto: p.rfid || '',
                      referencia: p.referencia || '',
                      descripcion: p.descripcion || '',
                      lote: p.lote || '',
                      caducidad: p.caducidad || '',
                    });
                  });
                }
              });
              this.excelMaletas.downloadExcel(rows, `maletas_relaciones_${new Date().toISOString().slice(0, 10)}.xlsx`);
            })
          );
        })
      )
      .subscribe({
        next: () => {
          this.excelLoading = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.excelError = err?.message || 'Error al exportar';
          this.excelLoading = false;
          this.cdr.detectChanges();
        },
      });
  }

  /** Carga masiva desde Excel. Con backend: crea en API. Sin backend: añade a lista local. */
  onExcelFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input?.files?.[0];
    if (!file) return;
    input.value = '';
    this.excelError = '';
    this.excelLoading = true;
    this.cdr.detectChanges();
    this.excelMaletas
      .parseExcelFile(file)
      .then((rows) => {
        const groups = new Map<string, ExcelMaletaRow[]>();
        for (const r of rows) {
          if (!r.nombreMaleta.trim() && !r.rfidMaestro.trim()) continue;
          const key = `${r.nombreMaleta}|${r.rfidMaestro}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(r);
        }
        const groupList = Array.from(groups.entries());
        if (groupList.length === 0) {
          this.excelLoading = false;
          this.excelError = 'No se encontraron maletas válidas en el Excel.';
          this.cdr.detectChanges();
          return;
        }
        if (!this.useBackend) {
          const newMaletas: MaletaItem[] = groupList.map(([_, productRows]) => {
            const first = productRows[0];
            const productRfids = productRows.filter((r) => r.rfidProducto.trim()).map((r) => r.rfidProducto);
            return {
              id: `maleta_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
              nombre: first.nombreMaleta.trim() || undefined,
              masterRfid: first.rfidMaestro.trim(),
              productRfids,
              createdAt: new Date().toISOString(),
            };
          });
          this.maletas = [...newMaletas, ...this.maletas];
          this.saveMaletasToStorage();
          this.excelLoading = false;
          this.cdr.detectChanges();
          return;
        }
        let done = 0;
        const total = groupList.length;
        groupList.forEach(([_, productRows]) => {
          const first = productRows[0];
          const nombre = first.nombreMaleta.trim() || 'Sin nombre';
          const masterRfid = first.rfidMaestro.trim();
          const withRfid = productRows.filter((r) => r.rfidProducto != null && String(r.rfidProducto).trim().length > 0);
          this.maletasApi.createMaleta({ nombre, masterRfid }).pipe(
            switchMap((created) => {
              if (!created) return of(null);
              if (withRfid.length === 0) return of(created);
              return from(withRfid).pipe(
                concatMap((r) =>
                  this.maletasApi.crearProductoEnMaleta(created.id, {
                    rfid: String(r.rfidProducto).trim(),
                    referencia: r.referencia?.trim() || undefined,
                    descripcion: r.descripcion?.trim() || undefined,
                    lote: r.lote?.trim() || undefined,
                    caducidad: r.caducidad?.trim() || undefined,
                  })
                ),
                toArray(),
                switchMap(() => of(created))
              );
            })
          ).subscribe({
            next: () => {
              done++;
              if (done === total) this.finishExcelImport();
            },
            error: () => {
              done++;
              if (done === total) this.finishExcelImport();
            },
          });
        });
      })
      .catch((err) => {
        this.excelError = err?.message || 'Error al leer el Excel.';
        this.excelLoading = false;
        this.cdr.detectChanges();
      });
  }

  private finishExcelImport(): void {
    this.excelLoading = false;
    if (this.useBackend) this.loadMaletasFromApi();
    this.cdr.detectChanges();
  }

  /** Descarga plantilla Excel con instrucciones para carga masiva. */
  downloadExcelTemplate(): void {
    this.excelMaletas.downloadTemplate();
  }

  /** Formato .txt: MAESTRO <rfid> = maleta; líneas siguientes = productos hasta el próximo MAESTRO. */
  private static readonly TXT_MAESTRO_PREFIX = 'MAESTRO ';

  /** Exporta las maletas a un .txt para guardar y saber qué hay que leer. */
  exportMaletasToTxt(): void {
    const lines: string[] = [
      '# Maletas - qué hay que leer',
      '# MAESTRO = RFID de la maleta. Líneas debajo = productos hasta el próximo MAESTRO.',
      '',
    ];
    for (const m of this.maletas) {
      lines.push(Maleta.TXT_MAESTRO_PREFIX + m.masterRfid);
      for (const rfid of m.productRfids) {
        lines.push(rfid.trim());
      }
      lines.push('');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `maletas_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Carga maletas desde un .txt (reemplaza las actuales). */
  importMaletasFromFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const text = (reader.result as string) || '';
      const loaded = this.parseMaletasTxt(text);
      if (loaded.length > 0) {
        this.maletas = loaded;
        this.saveMaletasToStorage();
        this.cdr.detectChanges();
      }
    };
    reader.readAsText(file, 'UTF-8');
  }

  /** Llamado al elegir un archivo .txt para cargar maletas. */
  onMaletasFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input?.files?.[0];
    if (file) {
      this.importMaletasFromFile(file);
      input.value = '';
    }
  }

  /** Parsea el formato .txt a lista de MaletaItem. */
  private parseMaletasTxt(text: string): MaletaItem[] {
    const result: MaletaItem[] = [];
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    let current: MaletaItem | null = null;
    for (const line of lines) {
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith(Maleta.TXT_MAESTRO_PREFIX)) {
        const masterRfid = line.slice(Maleta.TXT_MAESTRO_PREFIX.length).trim();
        if (masterRfid) {
          current = {
            id: `maleta_${Date.now()}_${result.length}`,
            masterRfid,
            productRfids: [],
            createdAt: new Date().toISOString(),
          };
          result.push(current);
        }
      } else if (current && line) {
        current.productRfids.push(line);
      }
    }
    return result;
  }

  ngOnDestroy(): void {
    this.stopRetryTimer();
    this.stopStatusPolling();
    this.stopUiRefresh();
    this.stopTagsPolling();
    this.disconnectRealtime();
  }

  private startRetryTimer(): void {
    this.stopRetryTimer();
    this.retryTimer = setInterval(() => {
      this.ngZone.run(() => {
        if (this.needsRetry) {
          if (this.retryCountdown <= 0) {
            this.retryCountdown = this.retryIntervalSeconds;
            this.loadReaders();
            this.loadAntennas();
          } else {
            this.retryCountdown--;
          }
        } else {
          this.retryCountdown = this.retryIntervalSeconds;
        }
        this.cdr.detectChanges();
      });
    }, 1000);
  }

  private stopRetryTimer(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Recarga API y resetea el temporizador de reintento. */
  forceReload(): void {
    this.error = '';
    this.retryCountdown = this.retryIntervalSeconds;
    this.loadReaders();
    this.loadAntennas();
    if (this.selectedReaderId) {
      this.refreshStatus();
    }
  }

  saveBaseUrl(): void {
    this.api.setBaseUrl(this.apiBaseUrl);
    this.error = '';
    this.loadReaders();
    this.loadAntennas();
  }

  loadReaders(): void {
    if (!this.api.getBaseUrl()) return;
    this.loading = true;
    this.error = '';
    this.api.getReaders().subscribe({
      next: (list) => {
        this.readers = list;
        if (list.length && !this.selectedReaderId) {
          this.selectedReaderId = list[0].id;
          this.restartStatusPolling();
        }
        this.refreshStatus();
        this.loading = false;
        if (list.length === 0) {
          this.retryCountdown = this.retryIntervalSeconds;
        }
      },
      error: (err) => {
        this.error = err?.message || 'Error al cargar lectores';
        this.loading = false;
        this.retryCountdown = this.retryIntervalSeconds;
      },
    });
  }

  loadAntennas(): void {
    if (!this.api.getBaseUrl()) return;
    this.api.getAntennas().subscribe({
      next: (list) => (this.antennas = list),
      error: () => (this.antennas = []),
    });
  }

  onReaderChange(): void {
    this.refreshStatus();
    this.restartStatusPolling();
  }

  refreshStatus(): void {
    if (!this.selectedReaderId) {
      this.readerStatus = null;
      return;
    }
    this.api.getReaderStatus(this.selectedReaderId).subscribe({
      next: (s) => {
        this.readerStatus = s;
        if (s?.reading && !this.sseConnected) {
          this.connectRealtime();
          this.startUiRefresh();
        }
      },
      error: () => (this.readerStatus = null),
    });
  }

  restartStatusPolling(): void {
    this.stopStatusPolling();
    if (!this.selectedReaderId) return;
    this.statusPolling = setInterval(() => this.refreshStatus(), 5000);
  }

  stopStatusPolling(): void {
    if (this.statusPolling) {
      clearInterval(this.statusPolling);
      this.statusPolling = null;
    }
  }

  startUiRefresh(): void {
    this.stopUiRefresh();
    this.uiRefreshInterval = setInterval(() => this.cdr.detectChanges(), 5000);
  }

  stopUiRefresh(): void {
    if (this.uiRefreshInterval) {
      clearInterval(this.uiRefreshInterval);
      this.uiRefreshInterval = null;
    }
  }

  /** Actualiza tagCounts con una lista de IDs (desde polling GET /api/readers/:id/tags). */
  private mergeTagsIntoTagCounts(tagIds: string[]): void {
    const now = new Date().toLocaleTimeString('es-MX');
    for (const id of tagIds) {
      const tagId = (id || '').trim();
      if (tagId.length < 4) continue;
      this.totalReads++;
      const existing = this.tagCounts.get(tagId);
      if (existing) {
        existing.count++;
        existing.lastSeen = now;
      } else {
        this.tagCounts.set(tagId, { id: tagId, count: 1, lastSeen: now });
      }
    }
  }

  private startTagsPolling(): void {
    this.stopTagsPolling();
    if (!this.selectedReaderId) return;
    this.tagsPollingInterval = setInterval(() => {
      this.api.getReaderTags(this.selectedReaderId).subscribe({
        next: (res) => {
          const tags = res?.tags;
          if (Array.isArray(tags) && tags.length > 0) {
            this.ngZone.run(() => {
              this.mergeTagsIntoTagCounts(tags);
              this.cdr.detectChanges();
            });
          }
        },
        error: () => { /* endpoint opcional; no hacer nada si falla */ },
      });
    }, 2000);
  }

  private stopTagsPolling(): void {
    if (this.tagsPollingInterval) {
      clearInterval(this.tagsPollingInterval);
      this.tagsPollingInterval = null;
    }
  }

  startReading(): void {
    if (!this.selectedReaderId || this.isReading) return;
    this.error = '';
    this.connectRealtime();
    this.startUiRefresh();
    this.startTagsPolling();
    this.api.startReader(this.selectedReaderId).subscribe({
      next: () => this.refreshStatus(),
      error: (e) => (this.error = e?.error?.message || e?.message || 'Error'),
    });
  }

  stopReading(): void {
    if (!this.selectedReaderId) return;
    this.error = '';
    this.api.stopReader(this.selectedReaderId).subscribe({
      next: () => {
        this.refreshStatus();
        this.stopUiRefresh();
        this.stopTagsPolling();
        this.disconnectRealtime();
      },
      error: (e) => (this.error = e?.error?.message || e?.message || 'Error'),
    });
  }

  resetReader(): void {
    if (!this.selectedReaderId || this.isReading) return;
    this.error = '';
    this.api.resetReader(this.selectedReaderId).subscribe({
      next: () => this.refreshStatus(),
      error: (e) => (this.error = e?.error?.message || e?.message || 'Error'),
    });
  }

  rebootReader(): void {
    if (!this.selectedReaderId || this.isReading) return;
    this.error = '';
    this.api.rebootReader(this.selectedReaderId).subscribe({
      next: () => this.refreshStatus(),
      error: (e) => (this.error = e?.error?.message || e?.message || 'Error'),
    });
  }

  resetAntennas(): void {
    if (!this.selectedReaderId || this.isReading) return;
    this.error = '';
    this.api.resetReaderAntennas(this.selectedReaderId).subscribe({
      next: () => this.loadAntennas(),
      error: (e) => (this.error = e?.error?.message || e?.message || 'Error'),
    });
  }

  extractTagId(data: unknown): string | null {
    if (data == null) return null;
    if (typeof data === 'string') {
      const s = data.trim();
      if (s.length >= 6 && /^[0-9A-Fa-f\-]+$/.test(s)) return s;
      if (s.length > 0) return s;
      return null;
    }
    if (Array.isArray(data)) {
      for (const item of data) {
        const id = this.extractTagId(item);
        if (id) return id;
      }
      return null;
    }
    if (typeof data === 'object') {
      const d = data as Record<string, unknown>;
      const preferidos = ['epc', 'tagId', 'tag_id', 'id', 'tagEPC', 'EPC'];
      for (const key of preferidos) {
        const v = d[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      const tag = d['tag'];
      if (tag) {
        const id = this.extractTagId(tag);
        if (id) return id;
      }
      if (Array.isArray(d['tags'])) {
        for (const t of d['tags']) {
          const id = this.extractTagId(t);
          if (id) return id;
        }
      }
      if (d['data']) {
        const id = this.extractTagId(d['data']);
        if (id) return id;
      }
      for (const v of Object.values(d)) {
        const id = this.extractTagId(v);
        if (id) return id;
      }
    }
    return null;
  }

  private processEvent(raw: string): void {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
    const now = new Date().toLocaleTimeString('es-MX');
    this.eventsReceived++;
    this.events.unshift({ time: now, data });
    if (this.events.length > this.maxEvents) this.events.pop();

    const tagIds = this.extractAllTagIds(data);
    for (const tagId of tagIds) {
      this.totalReads++;
      const existing = this.tagCounts.get(tagId);
      if (existing) {
        existing.count++;
        existing.lastSeen = now;
      } else {
        this.tagCounts.set(tagId, { id: tagId, count: 1, lastSeen: now });
      }
    }
  }

  private extractAllTagIds(data: unknown): string[] {
    const seen = new Set<string>();
    const add = (id: string | null) => {
      if (id && id.length >= 4 && !seen.has(id)) {
        seen.add(id);
        return id;
      }
      return null;
    };
    const ids: string[] = [];
    const main = add(this.extractTagId(data));
    if (main) ids.push(main);
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      if (Array.isArray(d['tags'])) {
        for (const t of d['tags']) {
          const id = add(this.extractTagId(t));
          if (id) ids.push(id);
        }
      }
    }
    return ids;
  }

  connectRealtime(): void {
    this.disconnectRealtime();
    const base = this.api.getBaseUrl();
    if (!base) return;

    const readerId = this.selectedReaderId || undefined;
    const wsUrl = this.api.getWebSocketUrl();
    const wsFull = readerId ? `${wsUrl}?readerId=${encodeURIComponent(readerId)}` : wsUrl;

    try {
      this.eventSource = new EventSource(
        readerId ? this.api.getRealtimeEventsUrl(readerId) : this.api.getRealtimeEventsUrl()
      );
      this.eventSource.onopen = () => this.ngZone.run(() => (this.sseConnected = true));
      this.eventSource.onerror = () => this.ngZone.run(() => (this.sseConnected = false));
      this.eventSource.onmessage = (ev) => this.ngZone.run(() => this.processEvent(ev.data));
      this.eventSource.addEventListener('tag', (ev: MessageEvent) => this.ngZone.run(() => this.processEvent(ev.data)));
      this.eventSource.addEventListener('detection', (ev: MessageEvent) => this.ngZone.run(() => this.processEvent(ev.data)));
      this.eventSource.addEventListener('event', (ev: MessageEvent) => this.ngZone.run(() => this.processEvent(ev.data)));
    } catch {
      this.sseConnected = false;
    }

    try {
      this.ws = new WebSocket(wsFull);
      this.ws.onopen = () => this.ngZone.run(() => (this.sseConnected = true));
      this.ws.onclose = () => this.ngZone.run(() => {
        if (!this.eventSource || this.eventSource.readyState !== EventSource.OPEN) {
          this.sseConnected = false;
        }
      });
      this.ws.onerror = () => this.ngZone.run(() => {
        if (!this.eventSource || this.eventSource.readyState !== EventSource.OPEN) {
          this.sseConnected = false;
        }
      });
      this.ws.onmessage = (ev) => this.ngZone.run(() => this.processEvent(ev.data));
    } catch {
    }
  }

  disconnectRealtime(): void {
    this.stopUiRefresh();
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.sseConnected = false;
  }

  clearEvents(): void {
    this.events = [];
  }

  clearTags(): void {
    this.tagCounts.clear();
    this.totalReads = 0;
  }

  filteredAntennas(): Antenna[] {
    if (!this.selectedReaderId) return this.antennas;
    return this.antennas.filter(
      (a) => a.readerId === this.selectedReaderId || a.id?.startsWith(this.selectedReaderId)
    );
  }
}
