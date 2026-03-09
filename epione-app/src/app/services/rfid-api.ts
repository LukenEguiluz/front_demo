import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface Reader {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface Antenna {
  id: string;
  readerId?: string;
  name?: string;
  enabled?: boolean;
  txPowerDbm?: number;
  rxSensitivityDbm?: number;
  [key: string]: unknown;
}

export interface ReaderStatus {
  connected?: boolean;
  reading?: boolean;
  [key: string]: unknown;
}

export interface ReaderGroup {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface ReaderGroupStatus {
  reading?: boolean;
  [key: string]: unknown;
}

/** Respuesta de POST /api/sessions/start */
export interface StartSessionResponse {
  sessionId: string;
  readerIds?: string[];
}

/** Vista de sesión (GET /api/sessions/:id). Sesiones de grupo: sessionId empieza por grp-. */
export interface SessionView {
  sessionId: string;
  groupId?: string;
  readerIds?: string[];
  status?: string;
  startTime?: string;
  epcs?: string[];
  epcCount?: number;
  totalReads?: number;
  [key: string]: unknown;
}

/** Respuesta de POST /api/sessions/force-reset */
export interface ForceResetResponse {
  message?: string;
  wasGroupSession?: boolean;
  stoppedReaderIds?: string[];
  groupId?: string;
  [key: string]: unknown;
}

const API_BASE_KEY = 'rfid_api_base_url';

@Injectable({ providedIn: 'root' })
export class RfidApi {
  private baseUrl = '';

  constructor(private http: HttpClient) {
    const raw = localStorage.getItem(API_BASE_KEY) || environment.rfidGatewayUrl || '';
    this.baseUrl = this.ensureAbsoluteUrl(raw);
    if (this.baseUrl && raw !== this.baseUrl) {
      localStorage.setItem(API_BASE_KEY, this.baseUrl);
    }
  }

  private ensureAbsoluteUrl(url: string): string {
    if (!url.trim()) return '';
    const u = url.replace(/\/$/, '').trim();
    if (u.startsWith('http://') || u.startsWith('https://')) return u;
    return `http://${u}`;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = this.ensureAbsoluteUrl(url);
    localStorage.setItem(API_BASE_KEY, this.baseUrl);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  getReaders(): Observable<Reader[]> {
    return this.http.get<Reader[]>(this.url('/api/readers'));
  }

  getReader(id: string): Observable<Reader> {
    return this.http.get<Reader>(this.url(`/api/readers/${id}`));
  }

  getReaderStatus(id: string): Observable<ReaderStatus> {
    return this.http.get<ReaderStatus>(this.url(`/api/readers/${id}/status`));
  }

  startReader(id: string): Observable<unknown> {
    return this.http.post(this.url(`/api/readers/${id}/start`), {});
  }

  stopReader(id: string): Observable<unknown> {
    return this.http.post(this.url(`/api/readers/${id}/stop`), {});
  }

  resetReader(id: string): Observable<unknown> {
    return this.http.post(this.url(`/api/readers/${id}/reset`), {});
  }

  rebootReader(id: string): Observable<unknown> {
    return this.http.post(this.url(`/api/readers/${id}/reboot`), {});
  }

  resetReaderAntennas(id: string): Observable<unknown> {
    return this.http.post(this.url(`/api/readers/${id}/antennas/reset`), {});
  }

  getAntennas(): Observable<Antenna[]> {
    return this.http.get<Antenna[]>(this.url('/api/antennas'));
  }

  getAntenna(id: string): Observable<Antenna> {
    return this.http.get<Antenna>(this.url(`/api/antennas/${id}`));
  }

  resetAntenna(antennaId: string): Observable<unknown> {
    return this.http.post(this.url(`/api/antennas/${antennaId}/reset`), {});
  }

  updateAntenna(id: string, body: Partial<Antenna>): Observable<Antenna> {
    return this.http.put<Antenna>(this.url(`/api/antennas/${id}`), body);
  }

  getRealtimeEventsUrl(readerId?: string, antenna?: string): string {
    const params = new URLSearchParams();
    if (readerId) params.set('readerId', readerId);
    if (antenna) params.set('antenna', antenna);
    const qs = params.toString();
    return this.url('/api/realtime/events') + (qs ? `?${qs}` : '');
  }

  /**
   * Tags leídos por el lector (polling). La API debe devolver { tags: string[] }.
   * Si el gateway no tiene SSE/WebSocket, puede exponer GET /api/readers/:id/tags
   * y la vista usará este método para actualizar los semáforos.
   */
  getReaderTags(readerId: string): Observable<{ tags: string[] }> {
    return this.http.get<{ tags: string[] }>(this.url(`/api/readers/${readerId}/tags`));
  }

  /**
   * Inicia una sesión de lectura.
   * body.groupId → sesión en todos los lectores del grupo (sessionId grp-<uuid>).
   * body.readerId → sesión en un solo lector.
   */
  startSession(body: { readerId?: string; groupId?: string }): Observable<StartSessionResponse> {
    return this.http.post<StartSessionResponse>(this.url('/api/sessions/start'), body);
  }

  /**
   * Fuerza el reinicio de sesiones (evitar 409 Conflict).
   * body.readerId → detiene la sesión de ese lector.
   * body.groupId → detiene la sesión del grupo y sus lectores.
   * body {} o sin body → detiene todas las sesiones activas.
   */
  forceResetSessions(body?: { readerId?: string; groupId?: string }): Observable<ForceResetResponse> {
    return this.http.post<ForceResetResponse>(this.url('/api/sessions/force-reset'), body ?? {});
  }

  /** Detiene la sesión (lector o grupo). Para grupo (grp-...) detiene todos los lectores del grupo. */
  stopSession(sessionId: string): Observable<unknown> {
    return this.http.post(this.url(`/api/sessions/${encodeURIComponent(sessionId)}/stop`), {});
  }

  /**
   * Vista de la sesión. Si sessionId es de grupo (grp-...), devuelve vista agregada:
   * epcs, epcCount, totalReads de todos los lectores del grupo.
   */
  getSession(sessionId: string): Observable<SessionView> {
    return this.http.get<SessionView>(this.url(`/api/sessions/${encodeURIComponent(sessionId)}`));
  }

  /** Indica si el sessionId corresponde a una sesión de grupo (formato grp-<uuid>). */
  isGroupSession(sessionId: string): boolean {
    return typeof sessionId === 'string' && sessionId.startsWith('grp-');
  }

  /** Grupos de lectores (listado para el selector). GET /api/groups */
  getReaderGroups(): Observable<ReaderGroup[]> {
    return this.http.get<ReaderGroup[]>(this.url('/api/groups'));
  }

  getReaderGroup(id: string): Observable<ReaderGroup> {
    return this.http.get<ReaderGroup>(this.url(`/api/groups/${id}`));
  }

  /** URL para WebSocket: ws://rfid.leyluz.com/ws/events */
  getWebSocketUrl(path = '/ws/events'): string {
    const base = this.baseUrl.replace(/^http/, 'ws');
    return base + path;
  }
}
