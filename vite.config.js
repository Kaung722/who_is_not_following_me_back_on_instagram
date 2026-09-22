import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Required for project Pages at username.github.io/repo-name/
  base: '/who_is_not_following_me_back_on_instagram/',
})
