import { Routes } from '@angular/router';
import { Home } from './pages/home/home';
import { Inventario } from './pages/inventario/inventario';
import { Reportes } from './pages/reportes/reportes';
import { Config } from './pages/config/config';
import { Lectura } from './pages/demo-tunel-rfid/lectura/lectura';
import { Maleta } from './pages/demo-tunel-rfid/maleta/maleta';
import { MaletaDb } from './pages/demo-tunel-rfid/maletadb/maletadb';
import { IcuInterventions } from './pages/icu-interventions/icu-interventions';

export const routes: Routes = [
  { path: '', component: Home },
  { path: 'icu-interventions', component: IcuInterventions },
  { path: 'inventario', component: Inventario },
  { path: 'reportes', component: Reportes },
  { path: 'config', component: Config },
  { path: 'db', component: MaletaDb },
  { path: 'demo-tunel-rfid', redirectTo: 'demo-tunel-rfid/lectura', pathMatch: 'full' },
  { path: 'demo-tunel-rfid/lectura', component: Lectura },
  { path: 'demo-tunel-rfid/maleta', component: Maleta },
  { path: 'demo-tunel-rfid/maletadb', component: MaletaDb },
  { path: '**', redirectTo: '' }
];
