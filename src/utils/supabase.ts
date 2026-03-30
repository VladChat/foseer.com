// File: src/utils/supabase.ts
// Purpose: Supabase client for client-side operations

import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';

// Get public environment variables
const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Validate required environment variables
if (!supabaseUrl || !supabaseAnonKey) {
  // In development, warn but don't crash
  if (import.meta.env.DEV) {
    console.warn('Supabase credentials not configured. Newsletter form will not work.');
    console.warn('Set PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_PUBLISHABLE_KEY in your .env file.');
  }
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
      // Check for unique constraint violation (duplicate email)
      if (error.code === '23505' || error.message.includes('duplicate')) {
        // Return neutral success for duplicates - don't expose that email exists
        return {
          success: true,
          message: 'Thanks for subscribing!',
          isDuplicate: true,
        };
      }

      // Log error for debugging but return generic message
      console.error('Newsletter subscription error:', error);
      return {
        success: false,
        message: 'Unable to process subscription. Please try again.',
      };
    }

    return {
      success: true,
      message: 'Thanks for subscribing! Check your inbox for confirmation.',
      isDuplicate: false,
    };
  } catch (err) {
    console.error('Newsletter subscription unexpected error:', err);
    return {
      success: false,
      message: 'Unable to process subscription. Please try again.',
    };
  }
}
