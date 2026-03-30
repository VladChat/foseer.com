// File: src/utils/supabase.ts
// Purpose: Supabase client for client-side operations

import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';

// Get public environment variables
const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Validate required environment variables
if (!supabaseUrl || !supabaseAnonKey) {
  console.error('[Supabase Error] Missing required environment variables');
  console.error('[Supabase Error] PUBLIC_SUPABASE_URL:', supabaseUrl ? 'present' : 'MISSING');
  console.error('[Supabase Error] PUBLIC_SUPABASE_PUBLISHABLE_KEY:', supabaseAnonKey ? 'present' : 'MISSING');
}

// Create Supabase client for client-side operations
export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient<Database>(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false, // No auth needed for newsletter
        autoRefreshToken: false,
      },
    })
  : null;

// Type for newsletter subscription insert
export type NewsletterSubscriberInsert = {
  email: string;
  email_normalized: string;
  source_page?: string;
  status?: 'pending' | 'confirmed' | 'unsubscribed' | 'bounced';
};

/**
 * Subscribe an email to the newsletter
 * Returns success even for duplicates (neutral success message)
 */
export async function subscribeToNewsletter(
  email: string,
  sourcePage?: string
): Promise<{ success: boolean; message: string; isDuplicate?: boolean }> {
  if (!supabase) {
    console.error('[Newsletter Error] Supabase client is null - check environment variables');
    return {
      success: false,
      message: 'Newsletter service is not configured.',
    };
  }

  // Normalize email: lowercase and trim
  const normalizedEmail = email.toLowerCase().trim();

  // Prepare the insert data
  const subscriberData: NewsletterSubscriberInsert = {
    email: email.trim(),
    email_normalized: normalizedEmail,
    source_page: sourcePage,
    status: 'pending',
  };

  try {
    const { data, error } = await supabase
      .from('newsletter_subscribers')
      .insert(subscriberData)
      .select()
      .single();

    if (error) {
      // Log full error details for debugging
      console.error('[Newsletter Error] Insert failed:', {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      });

      // Check for unique constraint violation (duplicate email)
      if (error.code === '23505' || error.message.includes('duplicate') || error.message.includes('unique')) {
        return {
          success: true,
          message: 'Thanks for subscribing!',
          isDuplicate: true,
        };
      }

      // Return user-friendly error message
      return {
        success: false,
        message: 'Unable to process subscription. Please try again.',
      };
    }

    return {
      success: true,
      message: 'Thanks for subscribing!',
      isDuplicate: false,
    };
  } catch (err) {
    console.error('[Newsletter Error] Unexpected error:', err);
    return {
      success: false,
      message: 'Unable to process subscription. Please try again.',
    };
  }
}
