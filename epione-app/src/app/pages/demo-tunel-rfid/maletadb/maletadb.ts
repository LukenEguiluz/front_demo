import { ChangeDetectorRef, Component, NgZone, OnInit, OnDestroy } from '@angular/core';
import { CommonModule, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { RfidApi, Reader, ReaderGroup, Antenna, ReaderStatus, ReaderGroupStatus } from '../../../services/rfid-api';
import { MaletasApi, MaletaBackend, ProductoBackend } from '../../../services/maletas-api';
import { ExcelMaletasService, ExcelMaletaRow } from '../../../services/excel-maletas';
import { environment } from '../../../../environments/environment';
import { forkJoin, from, of, throwError } from 'rxjs';
import { catchError, concatMap, switchMap, tap, toArray } from 'rxjs/operators';

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
  selector: 'app-maletadb',
  imports: [CommonModule, FormsModule, JsonPipe],
  templateUrl: './maletadb.html',
  styleUrl: './maletadb.css',
})
export class MaletaDb implements OnInit, OnDestroy {
  apiBaseUrl = '';
  readers: Reader[] = [];
  readerGroups: ReaderGroup[] = [];
  antennas: Antenna[] = [];
  /** 'reader' = un lector; 'group' = un grupo de lectores */
  selectionMode: 'reader' | 'group' = 'reader';
  selectedReaderId = '';
  selectedGroupId = '';
  readerStatus: ReaderStatus | null = null;
  readerGroupStatus: ReaderGroupStatus | null = null;
  /** Sesión activa (lector o grupo). POST /api/sessions/start devuelve sessionId (grp-<uuid> para grupos). */
  currentSessionId: string | null = null;
  loading = false;
  error = '';
  statusPolling: ReturnType<typeof setInterval> | null = null;
  uiRefreshInterval: ReturnType<typeof setInterval> | null = null;
  tagsPollingInterval: ReturnType<typeof setInterval> | null = null;
  sessionPollingInterval: ReturnType<typeof setInterval> | null = null;

  /** Timer para detener la lectura automáticamente a los 2 minutos. */
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  readonly autoStopReadingMs = 2 * 60 * 1000;

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
  /** IDs de maletas seleccionadas para lectura (semáforo y lista). Si está vacío se consideran todas. */
  selectedMaletaIdsForReading = new Set<string>();

  /** Todos los productos de la base de datos (borrar todos o seleccionados). */
  allProductos: ProductoBackend[] = [];
  loadingProductos = false;
  /** IDs de productos seleccionados para borrado masivo. */
  selectedProductIds = new Set<string>();
  /** True cuando la ruta es /db (vista solo DB: productos + maletas con Excel). */
  get isDbPage(): boolean {
    return this.router.url.includes('/db');
  }
  /** Producto en edición (modal). */
  showEditProducto: ProductoBackend | null = null;
  editProductoRfid = '';
  editProductoReferencia = '';
  editProductoDescripcion = '';
  editProductoLote = '';
  editProductoCaducidad = '';

  /** Editar maleta (DB): nombre y RFID maestro. */
  editingMaletaId: string | null = null;
  editMaletaNombre = '';
  editMaletaMasterRfid = '';

  /** Añadir producto a una maleta (DB): maleta id y campos del nuevo producto. */
  maletaIdForAddProduct: string | null = null;
  addProductoRfid = '';
  addProductoReferencia = '';
  addProductoDescripcion = '';
  addProductoLote = '';
  addProductoCaducidad = '';

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

  /** Siempre true en MaletaDb: siempre usa el backend. */
  readonly useBackend = true;

  excelLoading = false;
  excelError = '';

  /** Simular lectura del túnel: texto con etiquetas (una por línea o separadas por coma). */
  simulatedReadInput = '';

  /** Si false, se usa la lectura real del túnel (tagCounts) en lugar del texto simulado. */
  showSimulatedRead = true;
  private static readonly SHOW_SIMULATED_KEY = 'maletadb_show_simulated';

  constructor(
    public api: RfidApi,
    public maletasApi: MaletasApi,
    private excelMaletas: ExcelMaletasService,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef,
    private router: Router
  ) {}

  /** Leyendo = hay una sesión activa (iniciada con POST /api/sessions/start). */
  get isReading(): boolean {
    return !!this.currentSessionId;
  }

  /** Hay un lector o un grupo seleccionado para poder iniciar lectura. */
  get hasReaderOrGroupSelected(): boolean {
    if (this.selectionMode === 'reader') return !!this.selectedReaderId;
    return !!this.selectedGroupId;
  }

  /** Etiqueta del lector o grupo seleccionado (para mostrar "Usando: ..."). */
  get selectedReaderOrGroupLabel(): string {
    if (this.selectionMode === 'reader') {
      const r = this.readers.find((x) => x.id === this.selectedReaderId);
      return r ? (r.name || r.id) : this.selectedReaderId || '—';
    }
    const g = this.readerGroups.find((x) => x.id === this.selectedGroupId);
    return g ? (g.name || g.id) : this.selectedGroupId || '—';
  }

  /** Cantidad de tags únicos de la fuente activa; tras detener lectura se mantiene lo guardado en memoria. */
  get uniqueCount(): number {
    if (this.currentSessionId || this.tagCounts.size > 0) return this.tagCounts.size;
    if (this.showSimulatedRead) return this.simulatedReadTags.length;
    return this.tagCounts.size;
  }

  /**
   * Lista de tags: sesión activa o guardados en memoria (tras detener) → tagCounts; si no, simulación.
   * Así no se pierde lo ya leído para las maletas al detener.
   */
  get tagList(): TagCount[] {
    if (this.currentSessionId || this.tagCounts.size > 0) {
      return Array.from(this.tagCounts.values()).sort((a, b) => b.count - a.count);
    }
    const now = new Date().toLocaleTimeString('es-MX');
    return this.simulatedReadTags.map((id) => ({ id, count: 1, lastSeen: now })).sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Tags para la card "Tags RFID detectados (Maleta)": cuando hay maletas a leer,
   * solo los únicos que pertenecen a esas maletas (master + productos). Si no hay maletas seleccionadas, todos.
   */
  get tagListForMaletas(): TagCount[] {
    const list = this.tagList;
    if (this.maletasParaLeer.length === 0) return list;
    const expected = this.getExpectedTagUnion();
    return list.filter((t) => expected.has((t.id || '').trim()));
  }

  /** Número de tags únicos mostrados en la card (filtrados por maletas a leer cuando aplica). */
  get uniqueCountForMaletas(): number {
    return this.tagListForMaletas.length;
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

  /**
   * Fuente única de tags leídos para la sección Maleta (semáforos) y para simular lectura.
   * - Con sesión activa: tags del API (tagCounts).
   * - Sin sesión pero con tagCounts en memoria (tras detener lectura): se mantienen para no perder lo leído.
   * - Sin sesión y sin datos en memoria: simulación o vacío.
   */
  get allReadTags(): string[] {
    if (this.currentSessionId) return Array.from(this.tagCounts.keys());
    if (this.tagCounts.size > 0) return Array.from(this.tagCounts.keys());
    if (this.showSimulatedRead) return this.simulatedReadTags;
    return Array.from(this.tagCounts.keys());
  }

  /**
   * Etiquetas que cuentan para los semáforos de maletas: solo las leídas que están en "maletas a leer".
   * Si no hay maletas seleccionadas, todas las leídas cuentan.
   */
  get effectiveReadTags(): string[] {
    const read = this.allReadTags;
    if (this.maletasParaLeer.length === 0) return read;
    const expected = this.getExpectedTagUnion();
    return read.filter((id) => expected.has((id || '').trim()));
  }

  /** Indica si un RFID leído pertenece a alguna maleta a leer (para marcar en la tabla). */
  isTagInMaletas(tagId: string): boolean {
    if (this.maletasParaLeer.length === 0) return true;
    return this.getExpectedTagUnion().has((tagId || '').trim());
  }

  /** Conjunto de todos los RFIDs cargados en las maletas a leer (maestros + productos). */
  private getExpectedTagUnion(): Set<string> {
    const set = new Set<string>();
    for (const m of this.maletasParaLeer) {
      set.add((m.masterRfid || '').trim());
      for (const r of m.productRfids || []) {
        set.add((r || '').trim());
      }
    }
    set.delete('');
    return set;
  }

  /** Total de RFIDs esperados (maletas a leer) para resumen X / Y. */
  getExpectedTagUnionSize(): number {
    return this.getExpectedTagUnion().size;
  }

  /** True si se leyó al menos una etiqueta que no está en ninguna maleta a leer. */
  get hasUnknownTagRead(): boolean {
    if (this.maletasParaLeer.length === 0) return false;
    const expected = this.getExpectedTagUnion();
    return this.allReadTags.some((r) => r.length > 0 && !expected.has(r));
  }

  /** Lista única de etiquetas leídas que no están en ninguna maleta a leer (extras / no enlistados). */
  get extraUnlistedTags(): string[] {
    if (this.maletasParaLeer.length === 0) return [];
    const expected = this.getExpectedTagUnion();
    const unlisted = new Set<string>();
    for (const r of this.allReadTags) {
      if (r.length > 0 && !expected.has(r)) unlisted.add(r);
    }
    return Array.from(unlisted);
  }

  /** RFIDs de las maletas a leer que no se han leído (faltan por leer). */
  get missingTagsInMaletas(): string[] {
    if (this.maletasParaLeer.length === 0) return [];
    const expected = this.getExpectedTagUnion();
    const readSet = new Set(this.allReadTags.map((id) => (id || '').trim()));
    return Array.from(expected).filter((id) => id.length > 0 && !readSet.has(id));
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

  /** True si la fecha de caducidad ya pasó. Acepta texto de fecha o número serial de Excel. */
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
      localStorage.setItem(MaletaDb.SHOW_SIMULATED_KEY, String(this.showSimulatedRead));
    } catch {}
  }

  /** Maletas seleccionadas para lectura. Solo se muestran semáforos de las seleccionadas; si no hay ninguna, la lista queda vacía. */
  get maletasParaLeer(): MaletaItem[] {
    if (this.selectedMaletaIdsForReading.size === 0) return [];
    return this.maletas.filter((m) => this.selectedMaletaIdsForReading.has(m.id));
  }

  /** Texto de búsqueda para filtrar la lista del dropdown de maletas a leer. */
  maletasDropdownSearch = '';

  /** Maletas filtradas por búsqueda para el checklist (nombre, RFID maestro). */
  get maletasFilteredForChecklist(): MaletaItem[] {
    const q = (this.maletasDropdownSearch || '').trim().toLowerCase();
    if (!q) return this.maletas;
    return this.maletas.filter(
      (m) =>
        (m.nombre || '').toLowerCase().includes(q) ||
        (m.masterRfid || '').toLowerCase().includes(q)
    );
  }

  isMaletaSelectedForReading(id: string): boolean {
    return this.selectedMaletaIdsForReading.has(id);
  }

  toggleMaletaForReading(id: string): void {
    const next = new Set(this.selectedMaletaIdsForReading);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selectedMaletaIdsForReading = next;
    this.cdr.detectChanges();
  }

  selectAllMaletasForReading(): void {
    this.selectedMaletaIdsForReading = new Set(this.maletas.map((m) => m.id));
    this.cdr.detectChanges();
  }

  clearMaletasForReading(): void {
    this.selectedMaletaIdsForReading.clear();
    this.selectedMaletaIdsForReading = new Set(this.selectedMaletaIdsForReading);
    this.cdr.detectChanges();
  }

  /** Número de maletas completadas (semáforo verde) entre las seleccionadas para lectura. */
  get completedMaletasCount(): number {
    return this.maletasParaLeer.filter((m) => this.getMaletaStatus(m) === 'green').length;
  }

  /** Semáforo general: rojo si alguna maleta (seleccionada) tiene caducado; amarillo si hay producto extra; azul/verde según maletas a leer. */
  get generalSemaphoreStatus(): SemaphoreStatus {
    const list = this.maletasParaLeer;
    if (list.length === 0) return 'green';
    const statuses = list.map((m) => this.getMaletaStatus(m));
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

  /** URL por defecto para la vista (túnel RFID). */
  private static readonly MALETA_API = 'https://rfid.leyluz.com';

  /** True si no hay lectores ni grupos (muestra timer de reintento). */
  get needsRetry(): boolean {
    return !this.loading && this.api.getBaseUrl() !== '' && this.readers.length === 0 && this.readerGroups.length === 0;
  }

  ngOnInit(): void {
    this.api.setBaseUrl(MaletaDb.MALETA_API);
    this.apiBaseUrl = this.api.getBaseUrl();
    const apiUrl = this.maletasApi.getBaseUrl() || environment.maletasApiUrl || '';
    this.maletasApi.setBaseUrl(apiUrl);
    this.retryCountdown = this.retryIntervalSeconds;
    try {
      const saved = localStorage.getItem(MaletaDb.SHOW_SIMULATED_KEY);
      if (saved !== null) this.showSimulatedRead = saved === 'true';
    } catch {}
    this.loadMaletasFromApi();
    this.loadAllProductos();
    this.loadReaders();
    this.loadAntennas();
    this.startRetryTimer();
  }

  /** Selección de productos para borrado masivo. */
  toggleProductoSelection(id: string): void {
    if (this.selectedProductIds.has(id)) this.selectedProductIds.delete(id);
    else this.selectedProductIds.add(id);
    this.selectedProductIds = new Set(this.selectedProductIds);
    this.cdr.detectChanges();
  }

  get allProductosSelected(): boolean {
    return this.allProductos.length > 0 && this.allProductos.every((p) => this.selectedProductIds.has(p.id));
  }

  set allProductosSelected(v: boolean) {
    if (v) this.allProductos.forEach((p) => this.selectedProductIds.add(p.id));
    else this.selectedProductIds.clear();
    this.selectedProductIds = new Set(this.selectedProductIds);
    this.cdr.detectChanges();
  }

  selectAllProductos(): void {
    this.allProductosSelected = true;
  }

  clearProductoSelection(): void {
    this.selectedProductIds.clear();
    this.selectedProductIds = new Set(this.selectedProductIds);
    this.cdr.detectChanges();
  }

  get selectedProductosCount(): number {
    return this.selectedProductIds.size;
  }

  /** Borrar productos seleccionados. */
  deleteSelectedProductos(): void {
    const n = this.selectedProductIds.size;
    if (n === 0) return;
    if (!confirm(`¿Eliminar ${n} producto(s) seleccionado(s) de la base de datos? Se quitarán de todas las maletas.`)) return;
    const ids = Array.from(this.selectedProductIds);
    from(ids)
      .pipe(
        concatMap((id) => this.maletasApi.deleteProducto(id)),
        toArray()
      )
      .subscribe(() => {
        this.selectedProductIds.clear();
        this.selectedProductIds = new Set(this.selectedProductIds);
        this.loadAllProductos();
        this.loadMaletasFromApi();
        this.cdr.detectChanges();
      });
  }

  /** Borrar todos los productos. */
  deleteAllProductos(): void {
    if (this.allProductos.length === 0) return;
    if (!confirm(`¿Eliminar TODOS los productos (${this.allProductos.length}) de la base de datos? Se quitarán de todas las maletas.`)) return;
    from(this.allProductos)
      .pipe(
        concatMap((p) => this.maletasApi.deleteProducto(p.id)),
        toArray()
      )
      .subscribe(() => {
        this.selectedProductIds.clear();
        this.selectedProductIds = new Set(this.selectedProductIds);
        this.loadAllProductos();
        this.loadMaletasFromApi();
        this.cdr.detectChanges();
      });
  }

  /** Carga todos los productos de la API para listado/edición. */
  loadAllProductos(): void {
    this.loadingProductos = true;
    this.cdr.detectChanges();
    this.maletasApi.getProductos().subscribe((list) => {
      this.allProductos = list;
      this.loadingProductos = false;
      this.cdr.detectChanges();
    });
  }

  openEditProducto(p: ProductoBackend): void {
    this.showEditProducto = p;
    this.editProductoRfid = p.rfid ?? '';
    this.editProductoReferencia = p.referencia ?? '';
    this.editProductoDescripcion = p.descripcion ?? '';
    this.editProductoLote = p.lote ?? '';
    this.editProductoCaducidad = p.caducidad ?? '';
    this.cdr.detectChanges();
  }

  closeEditProducto(): void {
    this.showEditProducto = null;
    this.cdr.detectChanges();
  }

  saveEditProducto(): void {
    const p = this.showEditProducto;
    if (!p) return;
    const rfid = this.editProductoRfid.trim();
    if (!rfid) return;
    this.maletasApi.updateProducto(p.id, {
      rfid,
      referencia: this.editProductoReferencia.trim() || undefined,
      descripcion: this.editProductoDescripcion.trim() || undefined,
      lote: this.editProductoLote.trim() || undefined,
      caducidad: this.editProductoCaducidad.trim() || undefined,
    }).subscribe((updated) => {
      this.closeEditProducto();
      this.loadAllProductos();
      this.loadMaletasFromApi();
      this.cdr.detectChanges();
    });
  }

  deleteProductoConfirm(prod: ProductoBackend): void {
    if (!confirm(`¿Eliminar el producto "${prod.rfid}" (${prod.referencia || 'sin ref'}) de la base de datos? Esta acción quitará el producto de todas las maletas.`)) return;
    this.maletasApi.deleteProducto(prod.id).subscribe((ok) => {
      if (ok) {
        this.loadAllProductos();
        this.loadMaletasFromApi();
        this.cdr.detectChanges();
      }
    });
  }

  /** Quitar un producto de una maleta (solo la relación; el producto sigue en la DB). */
  quitarProductoDeMaletaConfirm(maletaId: string, prod: ProductoBackend): void {
    if (!confirm(`¿Quitar "${prod.rfid}" de esta maleta? El producto seguirá en la base de datos.`)) return;
    this.maletasApi.quitarProductoDeMaleta(maletaId, prod.id).subscribe((ok) => {
      if (ok) {
        this.loadMaletasFromApi();
        this.loadAllProductos();
        this.cdr.detectChanges();
      }
    });
  }

  openEditMaleta(m: MaletaItem): void {
    this.editingMaletaId = m.id;
    this.editMaletaNombre = m.nombre ?? '';
    this.editMaletaMasterRfid = m.masterRfid ?? '';
    this.cdr.detectChanges();
  }

  closeEditMaleta(): void {
    this.editingMaletaId = null;
    this.cdr.detectChanges();
  }

  saveEditMaleta(): void {
    const id = this.editingMaletaId;
    if (!id) return;
    const nombre = this.editMaletaNombre.trim();
    const masterRfid = this.editMaletaMasterRfid.trim();
    if (!masterRfid) return;
    this.maletasApi.updateMaleta(id, { nombre: nombre || undefined, masterRfid }).subscribe((updated) => {
      this.closeEditMaleta();
      this.loadMaletasFromApi();
      this.cdr.detectChanges();
    });
  }

  openAddProductoToMaleta(maletaId: string): void {
    this.maletaIdForAddProduct = maletaId;
    this.addProductoRfid = '';
    this.addProductoReferencia = '';
    this.addProductoDescripcion = '';
    this.addProductoLote = '';
    this.addProductoCaducidad = '';
    this.cdr.detectChanges();
  }

  closeAddProductoToMaleta(): void {
    this.maletaIdForAddProduct = null;
    this.cdr.detectChanges();
  }

  saveAddProductoToMaleta(): void {
    const maletaId = this.maletaIdForAddProduct;
    if (!maletaId || !this.addProductoRfid.trim()) return;
    this.maletasApi.crearProductoEnMaleta(maletaId, {
      rfid: this.addProductoRfid.trim(),
      referencia: this.addProductoReferencia.trim() || undefined,
      descripcion: this.addProductoDescripcion.trim() || undefined,
      lote: this.addProductoLote.trim() || undefined,
      caducidad: this.addProductoCaducidad.trim() || undefined,
    }).subscribe(() => {
      this.closeAddProductoToMaleta();
      this.loadMaletasFromApi();
      this.loadAllProductos();
      this.cdr.detectChanges();
    });
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
    /* MaletaDb siempre usa backend; no persistir en localStorage. */
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
  }

  deleteMaleta(item: MaletaItem, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.maletasApi.deleteMaleta(item.id).subscribe((ok) => {
      if (ok) this.loadMaletasFromApi();
      this.cdr.detectChanges();
    });
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

  /** Descarga todas las maletas y sus relaciones (productos) en un Excel. */
  exportToExcel(): void {
    this.excelError = '';
    this.excelLoading = true;
    this.cdr.detectChanges();
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

  /** Subir maletas con Excel: agrupa por nombre+RFID maestro y crea maletas + productos (asociaciones) en el backend. */
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
    this.loadMaletasFromApi();
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
      lines.push(MaletaDb.TXT_MAESTRO_PREFIX + m.masterRfid);
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

  /** Carga maletas desde un .txt (reemplaza solo en memoria; no se guardan en backend). */
  importMaletasFromFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const text = (reader.result as string) || '';
      const loaded = this.parseMaletasTxt(text);
      if (loaded.length > 0) {
        this.maletas = loaded;
        this.cdr.detectChanges();
      }
    };
    reader.readAsText(file, 'UTF-8');
  }

  /** Subir maletas desde .txt: formato MAESTRO <rfid> por línea, líneas siguientes = RFIDs de productos hasta el próximo MAESTRO. */
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
      if (line.startsWith(MaletaDb.TXT_MAESTRO_PREFIX)) {
        const masterRfid = line.slice(MaletaDb.TXT_MAESTRO_PREFIX.length).trim();
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
    this.stopSessionPolling();
    this.clearAutoStopTimer();
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
        if (list.length && !this.selectedReaderId && this.selectionMode === 'reader') {
          this.selectedReaderId = list[0].id;
          this.restartStatusPolling();
        }
        this.refreshStatus();
        this.loadReaderGroups();
      },
      error: (err) => {
        this.error = err?.message || 'Error al cargar lectores';
        this.loading = false;
        this.retryCountdown = this.retryIntervalSeconds;
      },
    });
  }

  loadReaderGroups(): void {
    if (!this.api.getBaseUrl()) {
      this.loading = false;
      return;
    }
    this.api.getReaderGroups().subscribe({
      next: (list) => {
        this.readerGroups = list;
        if (this.readers.length === 0 && list.length > 0 && !this.selectedGroupId) {
          this.selectionMode = 'group';
          this.selectedGroupId = list[0].id;
          this.restartStatusPolling();
        }
        if (this.readers.length === 0 && list.length === 0) {
          this.retryCountdown = this.retryIntervalSeconds;
        }
        this.loading = false;
        this.refreshStatus();
      },
      error: () => {
        this.readerGroups = [];
        this.loading = false;
        if (this.readers.length === 0) this.retryCountdown = this.retryIntervalSeconds;
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
    this.selectedGroupId = '';
    this.selectionMode = 'reader';
    this.readerGroupStatus = null;
    if (!this.selectedReaderId && this.readers.length > 0) this.selectedReaderId = this.readers[0].id;
    this.refreshStatus();
    this.restartStatusPolling();
  }

  onGroupChange(): void {
    this.selectedReaderId = '';
    this.selectionMode = 'group';
    this.readerStatus = null;
    if (!this.selectedGroupId && this.readerGroups.length > 0) this.selectedGroupId = this.readerGroups[0].id;
    this.refreshStatus();
    this.restartStatusPolling();
  }

  onSelectionModeChange(mode: 'reader' | 'group'): void {
    this.selectionMode = mode;
    if (mode === 'reader') {
      this.selectedGroupId = '';
      this.readerGroupStatus = null;
      if (!this.selectedReaderId && this.readers.length > 0) this.selectedReaderId = this.readers[0].id;
    } else {
      this.selectedReaderId = '';
      this.readerStatus = null;
      if (!this.selectedGroupId && this.readerGroups.length > 0) this.selectedGroupId = this.readerGroups[0].id;
    }
    this.refreshStatus();
    this.restartStatusPolling();
  }

  refreshStatus(): void {
    if (this.currentSessionId) return;
    if (this.selectionMode === 'group') {
      this.readerStatus = null;
      this.readerGroupStatus = null;
      return;
    }
    this.readerGroupStatus = null;
    if (!this.selectedReaderId) {
      this.readerStatus = null;
      return;
    }
    this.api.getReaderStatus(this.selectedReaderId).subscribe({
      next: (s) => (this.readerStatus = s),
      error: () => (this.readerStatus = null),
    });
  }

  restartStatusPolling(): void {
    this.stopStatusPolling();
    if (!this.hasReaderOrGroupSelected) return;
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
        error: () => { /* endpoint opcional */ },
      });
    }, 2000);
  }

  private startSessionPolling(): void {
    this.stopSessionPolling();
    const sessionId = this.currentSessionId;
    if (!sessionId) return;
    const fetchSession = (): void => {
      this.api.getSession(sessionId).subscribe({
        next: (view) => {
          this.ngZone.run(() => {
            if (view.epcs && view.epcs.length > 0) this.mergeTagsIntoTagCounts(view.epcs);
            if (view.totalReads != null) this.totalReads = view.totalReads;
            this.cdr.detectChanges();
          });
        },
        error: () => { /* sesión puede haber cerrado */ },
      });
    };
    fetchSession();
    this.sessionPollingInterval = setInterval(fetchSession, 1000);
  }

  private stopSessionPolling(): void {
    if (this.sessionPollingInterval) {
      clearInterval(this.sessionPollingInterval);
      this.sessionPollingInterval = null;
    }
  }

  private stopTagsPolling(): void {
    if (this.tagsPollingInterval) {
      clearInterval(this.tagsPollingInterval);
      this.tagsPollingInterval = null;
    }
  }

  /**
   * Inicia una sesión de lectura.
   * @param clearFirst si true, borra los RFID en memoria y empieza de cero; si false, continúa sumando a lo ya leído.
   */
  startReading(clearFirst = true): void {
    if (!this.hasReaderOrGroupSelected || this.isReading) return;
    this.error = '';
    const body = this.selectionMode === 'group'
      ? { groupId: this.selectedGroupId }
      : { readerId: this.selectedReaderId };
    this.api
      .startSession(body)
      .pipe(
        catchError((e) => {
          if (e?.status === 409) {
            return this.api.forceResetSessions(body).pipe(
              switchMap(() => this.api.startSession(body))
            );
          }
          return throwError(() => e);
        })
      )
      .subscribe({
        next: (res) => {
          if (clearFirst) {
            this.tagCounts.clear();
            this.totalReads = 0;
          }
          this.currentSessionId = res.sessionId;
          this.connectRealtime();
          this.startUiRefresh();
          this.startSessionPolling();
          this.startAutoStopTimer();
          this.cdr.detectChanges();
        },
        error: (e) => {
          const msg = e?.error?.message ?? e?.error?.error ?? e?.message;
          this.error = msg && typeof msg === 'string' ? msg : (e?.statusText || 'Error al iniciar sesión');
          this.cdr.detectChanges();
        },
      });
  }

  /** Continúa la lectura sumando a los RFID ya leídos (no borra la memoria). */
  continueReading(): void {
    this.startReading(false);
  }

  stopReading(): void {
    const sessionId = this.currentSessionId;
    if (!sessionId) return;
    this.error = '';
    this.clearAutoStopTimer();
    this.api.stopSession(sessionId).subscribe({
      next: () => {
        this.currentSessionId = null;
        this.stopSessionPolling();
        this.stopUiRefresh();
        this.disconnectRealtime();
        this.cdr.detectChanges();
      },
      error: (e) => (this.error = e?.error?.message || e?.message || 'Error'),
    });
  }

  private startAutoStopTimer(): void {
    this.clearAutoStopTimer();
    this.autoStopTimer = setTimeout(() => {
      this.autoStopTimer = null;
      this.ngZone.run(() => this.stopReading());
    }, this.autoStopReadingMs);
  }

  private clearAutoStopTimer(): void {
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
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

    const readerId = this.selectionMode === 'reader' ? (this.selectedReaderId || undefined) : undefined;
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
