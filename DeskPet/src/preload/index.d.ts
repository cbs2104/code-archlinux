import type { DeskPetApi } from '../shared/types'

declare global {
  interface Window {
    deskpet: DeskPetApi
  }
}

export {}
