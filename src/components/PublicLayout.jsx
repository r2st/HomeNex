export function PublicNav() {
  return (
    <nav className="border-b border-[var(--da-border)] bg-[var(--da-bg)]">
      <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2 font-semibold text-[var(--da-primary)] no-underline">DoAide Realty</a>
        <div className="flex items-center gap-6 text-sm">
          <a href="/tools" className="text-[var(--da-text-secondary)] hover:text-[var(--da-primary)] no-underline transition-colors">Free Tools</a>
          <a href="/blog" className="text-[var(--da-text-secondary)] hover:text-[var(--da-primary)] no-underline transition-colors">Blog</a>
          <a href="/embed" className="text-[var(--da-text-secondary)] hover:text-[var(--da-primary)] no-underline transition-colors">Embed</a>
          <a href="/" className="px-4 py-1.5 rounded-md text-sm font-medium bg-[var(--da-primary)] text-[var(--da-text-on-primary)] hover:bg-[var(--da-primary-hover)] no-underline transition-colors">Get Started</a>
        </div>
      </div>
    </nav>
  )
}

export function PublicFooter() {
  return (
    <footer className="border-t border-[var(--da-border)] mt-16 py-8">
      <div className="max-w-5xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-[var(--da-text-muted)]">
        <p>&copy; {new Date().getFullYear()} Apprend Technologies. All rights reserved.</p>
        <div className="flex items-center gap-6">
          <a href="/tools" className="hover:text-[var(--da-primary)] no-underline transition-colors">Free Tools</a>
          <a href="/blog" className="hover:text-[var(--da-primary)] no-underline transition-colors">Blog</a>
          <a href="https://doaide.com" className="hover:text-[var(--da-primary)] no-underline transition-colors">DoAide</a>
        </div>
      </div>
    </footer>
  )
}
