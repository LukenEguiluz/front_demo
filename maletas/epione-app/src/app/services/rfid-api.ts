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

  /** URL para WebSocket: ws://rfid.leyluz.com/ws/events */
  getWebSocketUrl(path = '/ws/events'): string {
    const base = this.baseUrl.replace(/^http/, 'ws');
    return base + path;
  }
}
