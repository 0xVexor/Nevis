package store

import (
	"context"
	"encoding/json"
)

func (s *Store) AccountAppearance(ctx context.Context, account string) (map[string]json.RawMessage, error) {
	rows, err := s.r.QueryContext(ctx, "SELECT name, value FROM account_appearance WHERE account = ?", account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := make(map[string]json.RawMessage)
	for rows.Next() {
		var name, value string
		if err := rows.Scan(&name, &value); err != nil {
			return nil, err
		}
		values[name] = json.RawMessage(value)
	}
	return values, rows.Err()
}

// SaveAccountAppearance changes only the supplied fields. On first use, existing account choices win over device defaults.
func (s *Store) SaveAccountAppearance(ctx context.Context, account string, values map[string]json.RawMessage, initialize bool) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	query := "INSERT INTO account_appearance(account, name, value) VALUES (?, ?, ?) ON CONFLICT(account, name) DO UPDATE SET value = excluded.value"
	if initialize {
		query = "INSERT INTO account_appearance(account, name, value) VALUES (?, ?, ?) ON CONFLICT(account, name) DO NOTHING"
	}
	for name, value := range values {
		if _, err := tx.ExecContext(ctx, query, account, name, string(value)); err != nil {
			return err
		}
	}
	return tx.Commit()
}
