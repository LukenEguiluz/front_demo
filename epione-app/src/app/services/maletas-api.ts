import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, map, of } from 'rxjs';
import { environment } from '../../environments/environment';

export interface ProductoBackend {
  id: string;
  rfid: string;
  referencia: string | null;
  descripcion: string | null;
  lote: string | null;
  caducidad: string | null;
  createdAt: string;
}

export interface MaletaBackend {
  id: string;
  nombre: string;
  masterRfid: string;
  parentMaletaId: string | null;
  createdAt: string;
  productRfids?: string[];
  productos?: ProductoBackend[];
}

const API_BASE_KEY = 'maletas_api_base_url';

@Injectable({ providedIn: 'root' })
export class MaletasApi {
  private baseUrl = '';

  constructor(private http: HttpClient) {
    const raw = localStorage.getItem(API_BASE_KEY) || environment.maletasApiUrl || '';
    this.baseUrl = this.ensureSlash(raw);
  }

  private ensureSlash(url: string): string {
    if (!url.trim()) return '';
    return url.replace(/\/$/, '').trim();
  }

  setBaseUrl(url: string): void {
    this.baseUrl = this.ensureSlash(url);
    localStorage.setItem(API_BASE_KEY, this.baseUrl);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private path(p: string): string {
    return `${this.baseUrl}${p}`;
  }

  getMaletas(): Observable<MaletaBackend[]> {
    return this.http.get<MaletaBackend[]>(this.path('/api/maletas')).pipe(
      catchError((err) => {
        console.warn('MaletasApi.getMaletas', err);
        return of([]);
      })
    );
  }

  getMaleta(id: string): Observable<MaletaBackend | null> {
    return this.http.get<MaletaBackend>(this.path(`/api/maletas/${id}`)).pipe(
      catchError(() => of(null))
    );
  }

  createMaleta(body: { nombre: string; masterRfid?: string; parentMaletaId?: string | null }): Observable<MaletaBackend | null> {
    return this.http.post<MaletaBackend>(this.path('/api/maletas'), body).pipe(
      catchError((err) => {
        console.warn('MaletasApi.createMaleta', err);
        return of(null);
      })
    );
  }

  updateMaleta(id: string, body: { nombre?: string; masterRfid?: string; parentMaletaId?: string | null }): Observable<MaletaBackend | null> {
    return this.http.put<MaletaBackend>(this.path(`/api/maletas/${id}`), body).pipe(
      catchError(() => of(null))
    );
  }

  deleteMaleta(id: string): Observable<boolean> {
    return this.http.delete(this.path(`/api/maletas/${id}`), { observe: 'response' }).pipe(
      map(() => true),
      catchError(() => of(false))
    );
  }

  getProductosMaleta(maletaId: string): Observable<ProductoBackend[]> {
    return this.http.get<ProductoBackend[]>(this.path(`/api/maletas/${maletaId}/productos`)).pipe(
      catchError(() => of([]))
    );
  }

  addProductoAMaleta(maletaId: string, productoId: string): Observable<unknown> {
    return this.http.post(this.path(`/api/maletas/${maletaId}/productos`), { productoId });
  }

  crearProductoEnMaleta(
    maletaId: string,
    body: { rfid: string; referencia?: string; descripcion?: string; lote?: string; caducidad?: string }
  ): Observable<ProductoBackend | null> {
    return this.http.post<ProductoBackend>(this.path(`/api/maletas/${maletaId}/productos/nuevo`), body).pipe(
      catchError(() => of(null))
    );
  }

  quitarProductoDeMaleta(maletaId: string, productoId: string): Observable<boolean> {
    return this.http.delete(this.path(`/api/maletas/${maletaId}/productos/${productoId}`), { observe: 'response' }).pipe(
      map(() => true),
      catchError(() => of(false))
    );
  }

  getProductos(): Observable<ProductoBackend[]> {
    return this.http.get<ProductoBackend[]>(this.path('/api/productos')).pipe(
      catchError(() => of([]))
    );
  }

  getProducto(id: string): Observable<ProductoBackend | null> {
    return this.http.get<ProductoBackend>(this.path(`/api/productos/${id}`)).pipe(
      catchError(() => of(null))
    );
  }

  getProductoByRfid(rfid: string): Observable<ProductoBackend | null> {
    return this.http.get<ProductoBackend>(this.path(`/api/productos/by-rfid/${encodeURIComponent(rfid)}`)).pipe(
      catchError(() => of(null))
    );
  }

  createProducto(body: {
    rfid: string;
    referencia?: string;
    descripcion?: string;
    lote?: string;
    caducidad?: string;
  }): Observable<ProductoBackend | null> {
    return this.http.post<ProductoBackend>(this.path('/api/productos'), body).pipe(
      catchError(() => of(null))
    );
  }

  updateProducto(
    id: string,
    body: { rfid?: string; referencia?: string; descripcion?: string; lote?: string; caducidad?: string }
  ): Observable<ProductoBackend | null> {
    return this.http.put<ProductoBackend>(this.path(`/api/productos/${id}`), body).pipe(
      catchError(() => of(null))
    );
  }

  deleteProducto(id: string): Observable<boolean> {
    return this.http.delete(this.path(`/api/productos/${id}`), { observe: 'response' }).pipe(
      map(() => true),
      catchError(() => of(false))
    );
  }

  health(): Observable<{ ok: boolean }> {
    return this.http.get<{ ok: boolean }>(this.path('/api/health')).pipe(
      catchError(() => of({ ok: false }))
    );
  }
}
