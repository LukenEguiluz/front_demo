import { ChangeDetectorRef, Component, NgZone, OnInit, OnDestroy } from '@angular/core';
import { CommonModule, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RfidApi, Reader, Antenna, ReaderStatus } from '../../../services/rfid-api';

interface TagCount {
  id: string;
  count: number;
  lastSeen: string;
}

@Component({
  selector: 'app-lectura',
  imports: [CommonModule, FormsModule, JsonPipe],
  templateUrl: './lectura.html',
  styleUrl: './lectura.css',
})
export class Lectura implements OnInit, OnDestroy {
  apiBaseUrl = '';
  readers: Reader[] = [];
  antennas: Antenna[] = [];
  selectedReaderId = '';
  readerStatus: ReaderStatus | null = null;
  loading = false;
  error = '';
  statusPolling: ReturnType<typeof setInterval> | null = null;
  uiRefreshInterval: ReturnType<typeof setInterval> | null = null;

  events: Array<{ time: string; data: unknown }> = [];
  maxEvents = 200;
  sseConnected = false;
  eventSource: EventSource | null = null;
  ws: WebSocket | null = null;
  eventsReceived = 0;

  /** Map: tagId -> { count, lastSeen } */
  tagCounts = new Map<string, TagCount>();
  totalReads = 0;

  constructor(public api: RfidApi, private ngZone: NgZone, private cdr: ChangeDetectorRef) {}

  get isReading(): boolean {
    return !!this.readerStatus?.reading;
  }

  get uniqueCount(): number {
    return this.tagCounts.size;
  }

  get tagList(): TagCount[] {
    return Array.from(this.tagCounts.values()).sort((a, b) => b.count - a.count);
  }

  ngOnInit(): void {
    this.apiBaseUrl = this.api.getBaseUrl();
    this.loadReaders();
    this.loadAntennas();
  }

  ngOnDestroy(): void {
    this.stopStatusPolling();
    this.stopUiRefresh();
    this.disconnectRealtime();
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
      },
      error: (err) => {
        this.error = err?.message || 'Error al cargar lectores';
        this.loading = false;
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

  startReading(): void {
    if (!this.selectedReaderId || this.isReading) return;
    this.error = '';
    this.connectRealtime();
    this.startUiRefresh();
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

  /** Extrae el ID del tag de cualquier estructura de evento (recursivo). */
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

  /** Procesa un evento recibido (SSE o WebSocket). */
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

  /** Extrae todos los IDs de tags de un evento (puede tener uno o varios). */
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

  /** Conecta SSE y WebSocket para recibir eventos en tiempo real. */
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
