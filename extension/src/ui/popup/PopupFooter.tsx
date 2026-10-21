import { Gem } from 'lucide-preact';
import { useEffect } from 'preact/hooks';
import { reviewUrl, shouldShowReview } from '../../review';
import { Button } from '../components/controls';
import { useSnapshot, useStore } from '../context';
import { proSummary } from '../format';

/** Pro status, plus the one neutral review prompt (LAUNCH.md) when it is due. */
export function PopupFooter({ onOpen }: { onOpen: (path: string) => void }) {
  const store = useStore();
  const { pro, state } = useSnapshot();
  const { platform } = store;
  const showReview = shouldShowReview(state.settings);
  const reviewState = state.settings.review.state;

  useEffect(() => {
    if (showReview && reviewState === 'pending') {
      void store.run({ type: 'setReviewState', state: 'shown' });
    }
  }, [showReview, reviewState, store]);

  return (
    <footer class="popup__foot">
      {showReview && (
        <div class="review" role="region" aria-label="Rate Headerbench">
          <p>
            Is Headerbench working for you? Rate it on the{' '}
            {platform.userAgent.includes('Edg/') ? 'Edge Add-ons store' : 'Chrome Web Store'}.
          </p>
          <div class="row">
            <Button
              small
              variant="primary"
              onClick={() => {
                void platform.openUrl(reviewUrl(platform.extensionId, platform.userAgent));
                void store.run({ type: 'setReviewState', state: 'rated' });
              }}
            >
              Rate
            </Button>
            <Button
              small
              variant="text"
              onClick={() => void store.run({ type: 'setReviewState', state: 'dismissed' })}
            >
              Not now
            </Button>
          </div>
        </div>
      )}
      <div class="popup__status">
        <Gem class="icon" size={16} aria-hidden="true" />
        <span class="grow truncate">{proSummary(pro, platform.now())}</span>
        <Button small variant="text" onClick={() => onOpen('app.html#/pro')}>
          {pro.source === 'license' ? 'Manage' : 'Get Pro'}
        </Button>
      </div>
    </footer>
  );
}
