/* ************************************************************************** */
/*                                                                            */
/*                                                        :::      ::::::::   */
/*   main.c                                             :+:      :+:    :+:   */
/*                                                    +:+ +:+         +:+     */
/*   By: ponzu <ponzu@student.42tokyo.jp>           +#+  +:+       +#+        */
/*                                                +#+#+#+#+#+   +#+           */
/*   Created: 2026/10/08 12:00:00 by ponzu             #+#    #+#             */
/*   Updated: 2026/10/08 12:00:00 by ponzu            ###   ########.fr       */
/*                                                                            */
/* ************************************************************************** */

#include <pthread.h>
#include <stdio.h>

static void	*worker(void *arg)
{
	int	*count;
	int	i;

	count = arg;
	i = 0;
	while (i < 100000)
	{
		(*count)++;
		i++;
	}
	return (NULL);
}

int	main(void)
{
	int			count;
	pthread_t	t1;
	pthread_t	t2;

	count = 0;
	pthread_create(&t1, NULL, worker, &count);
	pthread_create(&t2, NULL, worker, &count);
	pthread_join(t1, NULL);
	pthread_join(t2, NULL);
	printf("%d\n", count);
	return (0);
}
