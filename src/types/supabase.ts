// File: src/types/supabase.ts
// Purpose: TypeScript types for Supabase database schema

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      newsletter_subscribers: {
        Row: {
          id: string;
          email: string;
          email_normalized: string;
          source_page: string | null;
          status: 'pending' | 'confirmed' | 'unsubscribed' | 'bounced';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          email: string;
          email_normalized: string;
          source_page?: string | null;
          status?: 'pending' | 'confirmed' | 'unsubscribed' | 'bounced';
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          email_normalized?: string;
          source_page?: string | null;
          status?: 'pending' | 'confirmed' | 'unsubscribed' | 'bounced';
          created_at?: string;
          updated_at?: string;
        };
      };
    };
    Views: {};
    Functions: {};
    Enums: {};
  };
}
