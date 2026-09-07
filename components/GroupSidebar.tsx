'use client'

interface Group {
  name: string
  count: number
}

interface Props {
  groups: Group[]
  selected: string | null
  onSelect: (group: string | null) => void
  loading?: boolean
}

export default function GroupSidebar({ groups, selected, onSelect, loading }: Props) {
  return (
    <aside
      style={{
        width: 200,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        overflowY: 'auto',
        paddingRight: 4,
      }}
    >
      {loading ? (
        Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="skeleton" style={{ height: 34, borderRadius: 8 }} />
        ))
      ) : (
        <>
          <button
            className={`sidebar-item${selected === null ? ' active' : ''}`}
            onClick={() => onSelect(null)}
            style={{
              width: '100%',
              textAlign: 'left',
              background: 'none',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              padding: '0.45rem 0.75rem',
              cursor: 'pointer',
              fontSize: '0.85rem',
              fontWeight: selected === null ? 600 : 400,
              color: selected === null ? 'var(--color-accent-hover)' : 'var(--color-text-muted)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>All</span>
          </button>
          {groups.map((g) => (
            <button
              key={g.name}
              className={`sidebar-item${selected === g.name ? ' active' : ''}`}
              onClick={() => onSelect(g.name)}
              style={{
                width: '100%',
                textAlign: 'left',
                background: 'none',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                padding: '0.45rem 0.75rem',
                cursor: 'pointer',
                fontSize: '0.85rem',
                fontWeight: selected === g.name ? 600 : 400,
                color: selected === g.name ? 'var(--color-accent-hover)' : 'var(--color-text-muted)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {g.name}
              </span>
              <span
                style={{
                  fontSize: '0.72rem',
                  color: 'var(--color-text-muted)',
                  flexShrink: 0,
                }}
              >
                {g.count}
              </span>
            </button>
          ))}
        </>
      )}
    </aside>
  )
}
