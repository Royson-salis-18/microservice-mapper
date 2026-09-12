import { useState, useEffect, useRef } from 'react';

export function useWebSocket(url) {
  const [data, setData] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);
  const reconnectDelayRef = useRef(1000);

  useEffect(() => {
    let timeoutId;
    
    const connect = () => {
      try {
        wsRef.current = new WebSocket(url);
        
        wsRef.current.onopen = () => {
          setIsConnected(true);
          setError(null);
          reconnectDelayRef.current = 1000;
        };

        wsRef.current.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'GRAPH_SNAPSHOT') {
              setData(message.payload);
              setLastUpdate(Date.now());
            }
          } catch (e) {
            console.error('Error parsing WS message', e);
          }
        };

        wsRef.current.onclose = () => {
          setIsConnected(false);
          wsRef.current = null;
          
          const delay = reconnectDelayRef.current;
          reconnectDelayRef.current = Math.min(delay * 2, 30000);
          timeoutId = setTimeout(connect, delay);
        };

        wsRef.current.onerror = (e) => {
          setError('WebSocket error occurred');
        };
      } catch (err) {
        setError(err.message);
      }
    };

    connect();

    return () => {
      clearTimeout(timeoutId);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [url]);

  return { data, isConnected, lastUpdate, error };
}
