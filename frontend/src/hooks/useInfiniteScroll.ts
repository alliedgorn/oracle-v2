import { useRef, useCallback, useEffect, useState } from 'react';

interface UseInfiniteScrollOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => Promise<void>;
  threshold?: number; // pixels from top to trigger
}

export function useInfiniteScroll({
  containerRef,
  hasMore,
  loading,
  onLoadMore,
  threshold = 100,
}: UseInfiniteScrollOptions) {
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const prevScrollHeightRef = useRef(0);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || !hasMore || loading || isLoadingMore) return;

    if (container.scrollTop < threshold) {
      setIsLoadingMore(true);
      prevScrollHeightRef.current = container.scrollHeight;

      onLoadMore().finally(() => {
        // Preserve scroll position after prepending older messages
        requestAnimationFrame(() => {
          if (container) {
            const newScrollHeight = container.scrollHeight;
            container.scrollTop = newScrollHeight - prevScrollHeightRef.current;
          }
          setIsLoadingMore(false);
        });
      });
    }
  }, [containerRef, hasMore, loading, isLoadingMore, onLoadMore, threshold]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  return { isLoadingMore };
}
