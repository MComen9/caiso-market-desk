import MarketApp from '@/components/market-app';

/** Keep the server response small: the browser loads the verified static archives. */
export default function Home() {
  return <MarketApp />;
}
