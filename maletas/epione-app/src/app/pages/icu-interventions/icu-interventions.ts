import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgFor, NgIf } from '@angular/common';

interface Surgery {
  id: number;
  paciente: string;
  procedimiento: string;
  estado: string;
  fecha: string;
}

@Component({
  selector: 'app-icu-interventions',
  imports: [FormsModule, NgFor, NgIf],
  templateUrl: './icu-interventions.html',
  styleUrl: './icu-interventions.css',
})
export class IcuInterventions implements OnInit {
  estadoSeleccionado = 'PROGRAMADA';
  textoFiltro = '';

  cirugias: Surgery[] = [];

  itemsPerPageOptions = [5, 10, 20];
  itemsPerPage = 5;
  currentPage = 1;

  get cirugiasFiltradas(): Surgery[] {
    let data = this.cirugias;

    if (this.estadoSeleccionado) {
      data = data.filter(c => c.estado === this.estadoSeleccionado);
    }

    if (this.textoFiltro.trim()) {
      const term = this.textoFiltro.toLowerCase();
      data = data.filter(c =>
        c.paciente.toLowerCase().includes(term) ||
        c.procedimiento.toLowerCase().includes(term)
      );
    }

    return data;
  }

  get totalItems(): number {
    return this.cirugiasFiltradas.length;
  }

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.totalItems / this.itemsPerPage));
  }

  get paginaActualCirugias(): Surgery[] {
    const start = (this.currentPage - 1) * this.itemsPerPage;
    const end = start + this.itemsPerPage;
    return this.cirugiasFiltradas.slice(start, end);
  }

  ngOnInit(): void {}

  cambiarItemsPerPage(value: number) {
    this.itemsPerPage = value;
    this.currentPage = 1;
  }

  irPrimeraPagina() {
    this.currentPage = 1;
  }

  irPaginaAnterior() {
    if (this.currentPage > 1) {
      this.currentPage--;
    }
  }

  irPaginaSiguiente() {
    if (this.currentPage < this.totalPages) {
      this.currentPage++;
    }
  }

  irUltimaPagina() {
    this.currentPage = this.totalPages;
  }

  get paginatorInfo(): string {
    if (this.totalItems === 0) return '0 of 0';
    const start = (this.currentPage - 1) * this.itemsPerPage + 1;
    const end = Math.min(this.currentPage * this.itemsPerPage, this.totalItems);
    return `${start} - ${end} of ${this.totalItems}`;
  }
}
